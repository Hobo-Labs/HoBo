// Shared helpers for the inventory and placement modules (WP22): canonical
// JSON digests, protobuf-JSON event bodies, typed refusals and advisory
// telemetry. Nothing here reads a clock; callers pass `atMs`.
import { createHash } from "node:crypto";
import {
	create,
	fromJson,
	type JsonValue,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { isEventStoreOptimisticConflict, type PrincipalRef } from "@hobo/core";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Digest, OtelAttributes, Refusal, TelemetrySink } from "../ports.js";

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, arrays in
 * order. Inputs are protobuf-JSON values, so this is the RFC 8785 subset
 * digests need.
 */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Digest(value: JsonValue): Digest {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Event body for a generated record: its canonical protobuf JSON. */
export function body<T extends Message>(schema: GenMessage<T>, record: T): JsonValue {
	return toJson(schema, record);
}

/** Decode a persisted body; undefined when it is not that record (never throws). */
export function decode<T extends Message>(schema: GenMessage<T>, data: unknown): T | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	try {
		// SAFETY: a non-null, non-array object read back from the journal is JSON.
		return fromJson(schema, data as JsonValue, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

export function reason(code: string, message: string, remediation: string, subject = ""): ReasonRecord {
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

/** Epoch ms of an RFC 3339 timestamp, or undefined when it does not parse. */
export function parseTime(value: string): number | undefined {
	if (value === "") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Emit metric points. Telemetry is advisory (the journal is the record), so a
 * failing sink never turns a committed command into an error a caller retries.
 */
export function emit(
	sink: TelemetrySink | undefined,
	points: readonly Readonly<{
		name: string;
		kind: "counter" | "histogram" | "gauge";
		value: number;
		unit: string;
		atMs: number;
		attributes: OtelAttributes;
	}>[],
): void {
	if (sink === undefined || points.length === 0) return;
	sink.metrics(points).catch(() => undefined);
}

/** True when an append failed only because another writer moved the stream head. */
export function isConflict(error: unknown): boolean {
	return error instanceof Error && isEventStoreOptimisticConflict(error);
}
