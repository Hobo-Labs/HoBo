// Journal helpers shared by the change-window service and the pipeline
// controller: protobuf-JSON event bodies, tolerant decoding, stream-head CAS
// appends with idempotency keys, content digests, and advisory telemetry.
import { createHash } from "node:crypto";
import {
	fromJson,
	type JsonObject,
	type JsonValue,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type {
	DurableEventStore,
	EventEnvelope,
	PrincipalRef,
} from "@hobo/core";
import type { Digest, TelemetrySink } from "../ports.js";

const tagOf = Object.prototype.toString;

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

/** A persisted event body as JSON (bodies are JSON by construction). */
export function jsonOf<T>(data: T): JsonValue | undefined {
	if (data === undefined) return undefined;
	try {
		const parsed: JsonValue = JSON.parse(JSON.stringify(data));
		return parsed;
	} catch {
		return undefined;
	}
}

/** Event body for a generated record: its canonical protobuf JSON. */
export function body<T extends Message>(schema: GenMessage<T>, record: T): JsonValue {
	return toJson(schema, record);
}

/** Decode a persisted body; undefined when it is not that record (never throws). */
export function decode<T extends Message, D>(
	schema: GenMessage<T>,
	data: D,
): T | undefined {
	const json = jsonOf(data);
	if (!isJsonObject(json)) return undefined;
	try {
		return fromJson(schema, json, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

/** JSON with object keys sorted at every depth (stable digests). */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function digestOf(value: JsonValue): Digest {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function principalName(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Current revision of a stream (the seq of its last event; 0 when empty). */
export async function streamRevision(
	store: DurableEventStore,
	streamId: string,
): Promise<number> {
	const head = store.getStreamHead?.(streamId);
	if (head) return head.revision;
	let revision = 0;
	for await (const event of store.read(streamId)) revision = event.seq;
	return revision;
}

export type AppendOne = Readonly<{
	store: DurableEventStore;
	streamId: string;
	type: string;
	data: JsonValue;
	idempotencyKey: string;
	tenant: string;
	actor: PrincipalRef;
}>;

/**
 * Append one fact with stream-head CAS and an idempotency key. A concurrent
 * writer (CAS conflict) causes one re-read and retry; a repeated key returns
 * the event already recorded. Returns undefined only when both attempts lose
 * the race, which the caller reports as a journal conflict.
 */
export async function appendOnce(input: AppendOne): Promise<EventEnvelope | undefined> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const expectedSeq = await streamRevision(input.store, input.streamId);
		try {
			const result = await input.store.append(
				input.streamId,
				[
					{
						type: input.type,
						data: input.data,
						meta: { idempotencyKey: input.idempotencyKey },
					},
				],
				{ expectedSeq, actor: input.actor, tenant: input.tenant },
			);
			const event = result.appended[0] ?? result.deduped[0];
			if (event) return event;
		} catch {
			// Stream-head CAS lost to a concurrent writer: re-read and retry once.
		}
	}
	return undefined;
}

/**
 * Emit one counter point. Telemetry is advisory (the journal is the record),
 * so a failing sink never turns a committed command into an error.
 */
export function emitCounter(
	sink: TelemetrySink | undefined,
	point: Readonly<{
		name: string;
		atMs: number;
		attributes: Readonly<Record<string, string>>;
		value?: number;
		unit?: string;
	}>,
): void {
	sink
		?.metrics([
			{
				name: point.name,
				kind: "counter",
				value: point.value ?? 1,
				unit: point.unit ?? "{event}",
				atMs: point.atMs,
				attributes: point.attributes,
			},
		])
		.catch(() => undefined);
}
