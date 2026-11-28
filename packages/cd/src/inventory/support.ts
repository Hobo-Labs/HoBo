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
import type {
	Digest,
	OtelAttributes,
	Refusal,
	TelemetrySink,
} from "../ports.js";
import { emitMetrics } from "../telemetry/advisory.js";
import { isJsonArray, isJsonObject, jsonOf } from "./json.js";

export function canonicalJson(value: JsonValue): string {
	if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Digest(value: JsonValue): Digest {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function body<T extends Message>(
	schema: GenMessage<T>,
	record: T,
): JsonValue {
	return toJson(schema, record);
}

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

export async function emit(
	sink: TelemetrySink | undefined,
	points: readonly Readonly<{
		name: string;
		kind: "counter" | "histogram" | "gauge";
		value: number;
		unit: string;
		atMs: number;
		attributes: OtelAttributes;
	}>[],
): Promise<void> {
	if (sink === undefined || points.length === 0) return;
	await emitMetrics(sink, points);
}

export function isConflict<E>(error: E): boolean {
	return error instanceof Error && isEventStoreOptimisticConflict(error);
}
