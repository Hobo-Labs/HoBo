// Journal helpers shared by the Freight ledger and ingest: protobuf-JSON event
// bodies, tolerant decoding of bodies other work packages own, and principal
// rendering for the `*_by` fields.
import {
	fromJson,
	type JsonValue,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { PrincipalRef } from "@hobo/core";
import type { TelemetrySink } from "../ports.js";
import { isJsonObject, isJsonString, jsonOf } from "./json.js";

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

function freightIdIn(json: JsonValue | undefined): string | undefined {
	if (!isJsonObject(json)) return undefined;
	const direct = json.freightId ?? json.freight_id;
	return isJsonString(direct) ? direct : undefined;
}

/**
 * The Freight a body owned by another work package refers to (a Set, a
 * promotion), read structurally: `freightId`/`freight_id` at the top level or
 * one level down. `undefined` means the body is not an object at all, which
 * callers treat as unreadable; `""` means it names no Freight.
 */
export function referencedFreightId<D>(data: D): string | undefined {
	const json = jsonOf(data);
	if (!isJsonObject(json)) return undefined;
	const direct = freightIdIn(json);
	if (direct !== undefined) return direct;
	for (const value of Object.values(json)) {
		const nested = freightIdIn(value);
		if (nested !== undefined) return nested;
	}
	return "";
}

/** The first string field of a structurally read body ("" when none). */
export function stringField<D>(data: D, ...names: readonly string[]): string {
	const json = jsonOf(data);
	if (!isJsonObject(json)) return "";
	for (const name of names) {
		const value = json[name];
		if (isJsonString(value)) return value;
	}
	return "";
}

export function principalName(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * Emit one counter point. Telemetry is advisory (the journal is the record),
 * so a failing sink never turns a committed command into an error the caller
 * would retry.
 */
export function emitCounter(
	sink: TelemetrySink | undefined,
	point: Readonly<{
		name: string;
		unit: string;
		atMs: number;
		attributes: Readonly<Record<string, string>>;
		value?: number;
	}>,
): void {
	sink
		?.metrics([
			{
				name: point.name,
				kind: "counter",
				value: point.value ?? 1,
				unit: point.unit,
				atMs: point.atMs,
				attributes: point.attributes,
			},
		])
		.catch(() => undefined);
}
