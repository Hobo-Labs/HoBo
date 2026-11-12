// Journal helpers shared by the Freight ledger and ingest: protobuf-JSON event
// bodies, tolerant decoding of bodies other work packages own, and principal
// rendering for the `*_by` fields.
import { type DescMessage, fromJson, type JsonValue, type MessageShape, toJson } from "@bufbuild/protobuf";
import type { PrincipalRef } from "@hobo/core";
import { isPlainObject } from "./canonical.js";

/** Event body for a generated record: its canonical protobuf JSON. */
export function body<Desc extends DescMessage>(schema: Desc, record: MessageShape<Desc>): JsonValue {
	return toJson(schema, record);
}

/** Decode a persisted body; undefined when the bytes are not that record (never throws). */
export function decode<Desc extends DescMessage>(schema: Desc, data: unknown): MessageShape<Desc> | undefined {
	if (!isPlainObject(toJsonValue(data))) return undefined;
	try {
		return fromJson(schema, toJsonValue(data), { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

function toJsonValue(data: unknown): JsonValue {
	if (data === null || typeof data === "string" || typeof data === "number" || typeof data === "boolean") return data;
	if (Array.isArray(data)) return data.map(toJsonValue);
	if (typeof data === "object") {
		const out: { [key: string]: JsonValue } = {};
		for (const [key, value] of Object.entries(data)) {
			if (value !== undefined) out[key] = toJsonValue(value);
		}
		return out;
	}
	return null;
}

/**
 * The Freight a body owned by another work package refers to (a Set, a
 * promotion), read structurally: `freightId`/`freight_id` at the top level or
 * one level down. `undefined` means the body is not an object at all, which
 * callers treat as unreadable; `""` means it names no Freight.
 */
export function referencedFreightId(data: unknown): string | undefined {
	const json = toJsonValue(data);
	if (!isPlainObject(json)) return undefined;
	const direct = json.freightId ?? json.freight_id;
	if (typeof direct === "string") return direct;
	for (const value of Object.values(json)) {
		if (!isPlainObject(value)) continue;
		const nested = value.freightId ?? value.freight_id;
		if (typeof nested === "string") return nested;
	}
	return "";
}

/** A field of a structurally read body, as a string ("" when absent). */
export function stringField(data: unknown, ...names: readonly string[]): string {
	const json = toJsonValue(data);
	if (!isPlainObject(json)) return "";
	for (const name of names) {
		const value = json[name];
		if (typeof value === "string") return value;
	}
	return "";
}

export function principalName(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}
