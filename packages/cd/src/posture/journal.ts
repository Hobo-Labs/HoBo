// Journal helpers for the posture module (WP24): protobuf-JSON event bodies,
// tolerant decoding, CAS appends with idempotency keys, typed refusals and
// advisory telemetry. Nothing here reads a clock; callers pass instants.
import { createHash } from "node:crypto";
import {
	create,
	fromJson,
	type JsonValue,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import {
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	isEventStoreOptimisticConflict,
	type JsonObject,
	type PrincipalRef,
} from "@hobo/core";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type {
	Digest,
	OtelAttributes,
	Refusal,
	TelemetrySink,
} from "../ports.js";

const tagOf = Object.prototype.toString;

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

/** A persisted value as plain JSON, or undefined when it is not JSON. */
export function jsonOf<T>(data: T): JsonValue | undefined {
	if (data === undefined) return undefined;
	try {
		const parsed: JsonValue = JSON.parse(JSON.stringify(data));
		return parsed;
	} catch {
		return undefined;
	}
}

/** Canonical JSON (sorted keys, no whitespace): the digest input. */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestOf(value: JsonValue): Digest {
	return `sha256:${sha256Hex(canonicalJson(value))}`;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function asDigest(value: string): Digest | undefined {
	// SAFETY: matched against the Digest pattern.
	return DIGEST.test(value) ? (value as Digest) : undefined;
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
	const json = jsonOf(data);
	if (!isJsonObject(json)) return undefined;
	try {
		return fromJson(schema, json, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

export function reason(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function refuse(...reasons: readonly ReasonRecord[]): Refusal {
	return { ok: false, reasons };
}

export function principalName(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function parseTime(value: string): number | undefined {
	if (value === "") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

export function metaString<T>(
	event: EventEnvelope<T>,
	key: string,
): string | undefined {
	const value = event.meta?.[key];
	return isJsonString(value) ? value : undefined;
}

/** Current revision of a stream (its last seq), from the fenced head when the store has one. */
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
	tenant: string;
	actor: PrincipalRef;
	streamId: string;
	event: EventInput;
	idempotencyKey: string;
}>;

const APPEND_ATTEMPTS = 4;

/** The event a key resolved to, and whether this call appended it (false: an earlier call did). */
export type Appended = Readonly<{ event: EventEnvelope; fresh: boolean }>;

/**
 * Append one fact under stream-head CAS with an idempotency key. A concurrent
 * writer causes a re-read and retry; a repeated key returns the recorded
 * event. Undefined only when every attempt loses the race.
 */
export async function appendOnce(
	input: AppendOne,
): Promise<Appended | undefined> {
	for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
		const expectedSeq = await streamRevision(input.store, input.streamId);
		try {
			const result = await input.store.append(
				input.streamId,
				[
					{
						...input.event,
						meta: {
							...(input.event.meta ?? {}),
							idempotencyKey: input.idempotencyKey,
						},
					},
				],
				{ expectedSeq, actor: input.actor, tenant: input.tenant },
			);
			const fresh = result.appended[0];
			if (fresh) return { event: fresh, fresh: true };
			const recorded = result.deduped[0];
			if (recorded) return { event: recorded, fresh: false };
		} catch (error) {
			if (!(error instanceof Error) || !isEventStoreOptimisticConflict(error))
				throw error;
		}
	}
	return undefined;
}

export type MetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: OtelAttributes;
}>;

/** Telemetry is advisory (the journal is the record): a failing sink never fails a committed command. */
export function emit(
	sink: TelemetrySink | undefined,
	points: readonly MetricPoint[],
): void {
	if (sink === undefined || points.length === 0) return;
	sink.metrics(points).catch(() => undefined);
}
