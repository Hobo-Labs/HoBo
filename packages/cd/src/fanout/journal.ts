// Journal plumbing shared by the fan-out and failover controllers (WP23).
// Everything here is either pure (ids, time, reasons, codecs) or a thin,
// typed wrapper over the frozen DurableEventStore port. No decision logic.
import { createHash } from "node:crypto";
import {
	create,
	type DescMessage,
	fromJson,
	type JsonObject,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	EventStoreError,
	type PrincipalRef,
} from "@hobo/core";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { OtelMetricPoint, TelemetrySink } from "../ports.js";

// ── Time ───────────────────────────────────────────────────────────────────
export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Epoch ms of a recorded RFC 3339 timestamp; 0 when absent or unreadable. */
export function msOf(value: string): number {
	if (value === "") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

// ── Ids ────────────────────────────────────────────────────────────────────
export function sha256Hex(...parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(part);
		hash.update("\u0000");
	}
	return hash.digest("hex");
}

export function principalName(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

// ── Reasons ────────────────────────────────────────────────────────────────
export function reason(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function refuse(...reasons: readonly ReasonRecord[]) {
	return { ok: false as const, reasons };
}

// ── Codecs (protobuf JSON is the only body format) ────────────────────────
export function encode<Desc extends DescMessage>(
	schema: Desc,
	message: Parameters<typeof toJson<Desc>>[1],
): JsonValue {
	return toJson(schema, message);
}

/** Parse a protobuf JSON body; undefined when it does not parse. */
export function decode<Desc extends DescMessage>(
	schema: Desc,
	value: JsonValue | undefined,
): ReturnType<typeof fromJson<Desc>> | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		return fromJson(schema, value, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

// JSON guards for values that arrive already parsed (event bodies). They read
// the runtime tag, the idiom @hobo/core uses, and establish the JSON contract
// callers then decode against a generated schema.
const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

/** A non-null, non-array plain object. */
export function isJsonObject<T>(value: T): value is T & JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function jsonObject<T>(value: T): JsonObject {
	return isJsonObject(value) ? value : {};
}

export function jsonString(value: JsonValue | undefined): string {
	return isJsonString(value) ? value : "";
}

export function jsonNumber(value: JsonValue | undefined): number {
	return isJsonNumber(value) && Number.isFinite(value) ? value : 0;
}

export function jsonStrings(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter(isJsonString) : [];
}

// ── Store ──────────────────────────────────────────────────────────────────
export async function readStream(
	store: DurableEventStore,
	streamId: string,
): Promise<EventEnvelope[]> {
	const out: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) out.push(event);
	return out;
}

/** Stream ids of every event of `type` for the tenant, in journal order, de-duplicated. */
export async function streamsWith(
	store: DurableEventStore,
	type: string,
	tenant: string,
): Promise<string[]> {
	const seen = new Set<string>();
	const out: string[] = [];
	for await (const entry of store.readAll({ filter: { type }, tenant })) {
		if (seen.has(entry.event.streamId)) continue;
		seen.add(entry.event.streamId);
		out.push(entry.event.streamId);
	}
	return out;
}

/** Events of `type` for the tenant, in journal order. */
export async function eventsOf(
	store: DurableEventStore,
	type: string,
	tenant: string,
): Promise<EventEnvelope[]> {
	const out: EventEnvelope[] = [];
	for await (const entry of store.readAll({ filter: { type }, tenant }))
		out.push(entry.event);
	return out;
}

export type AppendInput = Readonly<{
	store: DurableEventStore;
	streamId: string;
	expectedSeq: number;
	events: readonly EventInput[];
	actor: PrincipalRef;
	tenant: string;
}>;

/**
 * CAS append at the folded head. A concurrent writer makes this throw the
 * store's OptimisticSequenceConflictError; callers re-fold on the next tick.
 */
export async function appendAt(input: AppendInput): Promise<number> {
	const result = await input.store.append(input.streamId, [...input.events], {
		expectedSeq: input.expectedSeq,
		actor: input.actor,
		tenant: input.tenant,
	});
	return input.expectedSeq + result.appended.length;
}

const CONFLICT_CODES: ReadonlySet<string> = new Set([
	"OPTIMISTIC_SEQUENCE_CONFLICT",
	"SUBSCRIPTION_LEASE_CONFLICT",
	"LEASE_CONFLICT",
	"STALE_FENCE",
]);

/** A concurrent writer or lease holder won: re-fold on the next tick. */
export function isConflict<T>(error: T): boolean {
	if (error instanceof EventStoreError) return CONFLICT_CODES.has(error.code);
	return (
		error instanceof Error &&
		"code" in error &&
		CONFLICT_CODES.has(String(error.code))
	);
}

// ── Leases ─────────────────────────────────────────────────────────────────
export type LeaseRunner = <T>(
	subscriptionId: string,
	run: () => Promise<T>,
) => Promise<{ held: true; value: T } | { held: false }>;

/**
 * Run `run` while holding the durable subscription lease `subscriptionId`
 * (partition = tenant). On stores without durable leases (single process),
 * a process-local lock gives the same one-holder guarantee; the stream CAS
 * still protects the journal either way.
 */
export function leaseRunner(
	store: DurableEventStore,
	tenant: string,
	holderId: string,
	ttlMs: number,
): LeaseRunner {
	const local = new Set<string>();
	return async (subscriptionId, run) => {
		if (store.claimSubscription === undefined) {
			if (local.has(subscriptionId)) return { held: false };
			local.add(subscriptionId);
			try {
				return { held: true, value: await run() };
			} finally {
				local.delete(subscriptionId);
			}
		}
		let lease: Awaited<ReturnType<NonNullable<typeof store.claimSubscription>>>;
		try {
			lease = await store.claimSubscription({
				subscriptionId,
				partitionId: tenant,
				holderId,
				leaseTtlMs: ttlMs,
			});
		} catch (error) {
			if (isConflict(error)) return { held: false };
			throw error;
		}
		try {
			return { held: true, value: await run() };
		} finally {
			await store
				.releaseSubscription?.({
					subscriptionId,
					partitionId: tenant,
					holderId,
					fenceToken: lease.fenceToken,
				})
				.catch(() => undefined);
		}
	};
}

// ── Telemetry ──────────────────────────────────────────────────────────────
export function emit(
	sink: TelemetrySink | undefined,
	points: readonly OtelMetricPoint[],
): void {
	if (sink === undefined || points.length === 0) return;
	// Telemetry never decides and never blocks delivery.
	void sink.metrics(points).catch(() => undefined);
}

export function counter(
	name: string,
	atMs: number,
	attributes: Readonly<Record<string, string>>,
	value = 1,
	unit = "1",
): OtelMetricPoint {
	return { name, kind: "counter", value, unit, atMs, attributes };
}

export function gauge(
	name: string,
	atMs: number,
	attributes: Readonly<Record<string, string>>,
	value: number,
	unit = "1",
): OtelMetricPoint {
	return { name, kind: "gauge", value, unit, atMs, attributes };
}
