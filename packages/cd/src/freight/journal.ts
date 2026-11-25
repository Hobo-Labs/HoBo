import {
	fromJson,
	type JsonValue,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { PrincipalRef } from "@hobo/core";
import type { TelemetrySink } from "../ports.js";
import { emitMetrics } from "../telemetry/advisory.js";
import { isJsonObject, isJsonString, jsonOf } from "./json.js";

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

function freightIdIn(json: JsonValue | undefined): string | undefined {
	if (!isJsonObject(json)) return undefined;
	const direct = json.freightId ?? json.freight_id;
	return isJsonString(direct) ? direct : undefined;
}

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

export async function emitCounter(
	sink: TelemetrySink | undefined,
	point: Readonly<{
		name: string;
		unit: string;
		atMs: number;
		attributes: Readonly<Record<string, string>>;
		value?: number;
	}>,
): Promise<void> {
	await emitMetrics(sink, [
		{
			name: point.name,
			kind: "counter",
			value: point.value ?? 1,
			unit: point.unit,
			atMs: point.atMs,
			attributes: point.attributes,
		},
	]);
}
