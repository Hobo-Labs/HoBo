// Journal helpers for the promotion saga: protobuf-JSON event bodies, tolerant
// decoding, canonical digests, stream-head CAS appends with idempotency keys,
// and advisory telemetry. Guards are tag-based so callers keep their evidence.
import { createHash } from "node:crypto";
import { fromJson, type Message, toJson } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type {
	DurableEventStore,
	EventEnvelope,
	JsonObject,
	JsonValue,
	PrincipalRef,
} from "@hobo/core";
import type { Digest, TelemetrySink } from "../ports.js";

const tagOf = Object.prototype.toString;

/** A readonly port input built field by field (optional fields added only when present). */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

/** Cross a value over the JSON boundary (drops undefined, rejects bigint). */
export function toJsonValue<T>(value: T): JsonValue {
	// SAFETY: JSON.parse of JSON.stringify output is a JSON value by construction.
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Key-sorted at every depth (arrays keep their order); code-unit order. */
export function sortDeep(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (isJsonObject(value)) {
		const out: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort()) {
			const child = value[key];
			if (child !== undefined) out[key] = sortDeep(child);
		}
		return out;
	}
	return value;
}

/** Deterministic compact JSON: sorted keys at every depth. */
export function canonicalJson<T>(value: T): string {
	return JSON.stringify(sortDeep(toJsonValue(value)));
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function digestOf<T>(value: T): Digest {
	return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Event body for a generated record: its canonical protobuf JSON. */
export function body<T extends Message>(
	schema: GenMessage<T>,
	record: T,
): JsonValue {
	return toJson(schema, record);
}

/** Decode a persisted body; undefined when it is not that record (never throws). */
export function decode<T extends Message, D>(
	schema: GenMessage<T>,
	data: D,
): T | undefined {
	const json = toJsonValue(data);
	if (!isJsonObject(json)) return undefined;
	try {
		return fromJson(schema, json, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

export function principalName(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Epoch ms of an RFC 3339 instant; undefined when absent or unparseable. */
export function msOf(instant: string): number | undefined {
	if (instant === "") return undefined;
	const ms = Date.parse(instant);
	return Number.isNaN(ms) ? undefined : ms;
}

export async function readStream(
	store: DurableEventStore,
	streamId: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) events.push(event);
	return events;
}

async function streamRevision(
	store: DurableEventStore,
	streamId: string,
): Promise<number> {
	const head = store.getStreamHead?.(streamId);
	if (head) return head.revision;
	let revision = 0;
	for await (const event of store.read(streamId)) revision = event.seq;
	return revision;
}

export type AppendEvents = Readonly<{
	store: DurableEventStore;
	streamId: string;
	events: readonly Readonly<{
		type: string;
		data: JsonValue;
		idempotencyKey: string;
	}>[];
	tenant: string;
	actor: PrincipalRef;
}>;

/** Append several facts atomically (one CAS); same retry rule as appendOnce. */
export async function appendAll(
	input: AppendEvents,
): Promise<readonly EventEnvelope[] | undefined> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const expectedSeq = await streamRevision(input.store, input.streamId);
		try {
			const result = await input.store.append(
				input.streamId,
				input.events.map((event) => ({
					type: event.type,
					data: event.data,
					meta: { idempotencyKey: event.idempotencyKey },
				})),
				{ expectedSeq, actor: input.actor, tenant: input.tenant },
			);
			return [...result.deduped, ...result.appended];
		} catch {
			// Stream-head CAS lost to a concurrent writer: re-read and retry once.
		}
	}
	return undefined;
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
 * Append one fact with stream-head CAS and an idempotency key. A lost CAS race
 * re-reads and retries once; a repeated key returns the event already
 * recorded. Undefined only when both attempts lose (a journal conflict).
 */
export async function appendOnce(
	input: AppendOne,
): Promise<EventEnvelope | undefined> {
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
 * Emit one metric point. Telemetry is advisory (the journal is the record),
 * so a failing sink never turns a committed command into an error.
 */
export function emitMetric(
	sink: TelemetrySink,
	point: Readonly<{
		name: string;
		atMs: number;
		attributes: Readonly<Record<string, string>>;
		value?: number;
		unit?: string;
		kind?: "counter" | "histogram" | "gauge";
	}>,
): void {
	sink
		.metrics([
			{
				name: point.name,
				kind: point.kind ?? "counter",
				value: point.value ?? 1,
				unit: point.unit ?? "{event}",
				atMs: point.atMs,
				attributes: point.attributes,
			},
		])
		.catch(() => undefined);
}
