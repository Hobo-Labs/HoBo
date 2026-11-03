import { createHash } from "node:crypto";
import {
	fromJson,
	type JsonValue as ProtobufJsonValue,
	toJson,
} from "@bufbuild/protobuf";
import {
	type PricingRejected,
	PricingRejectedSchema,
	type QuoteScenario,
	QuoteScenarioSchema,
	type QuoteVector,
	QuoteVectorSchema,
} from "./_generated/pricing_pb.js";

export type JsonValue = ProtobufJsonValue;
export type JsonObject = Record<string, JsonValue>;

export function parseJson(text: string): JsonValue | undefined {
	try {
		// SAFETY: JSON.parse produces only JSON values; message parsers refine them next.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		Object(value) === value
	);
}

function sortJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isJsonObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortJson(value[key] ?? null)]),
	);
}

export function stableJson(value: JsonValue): string {
	return JSON.stringify(sortJson(value));
}

export function stableHash(value: JsonValue): string {
	return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function parseQuoteScenario(
	value: JsonValue,
): QuoteScenario | undefined {
	try {
		return fromJson(QuoteScenarioSchema, value);
	} catch {
		return undefined;
	}
}

export function quoteScenarioToJson(scenario: QuoteScenario): JsonValue {
	return toJson(QuoteScenarioSchema, scenario, { alwaysEmitImplicit: true });
}

export function quoteVectorToJson(vector: QuoteVector): JsonValue {
	return toJson(QuoteVectorSchema, vector, { alwaysEmitImplicit: true });
}

export function pricingRejectedToJson(rejection: PricingRejected): JsonValue {
	return toJson(PricingRejectedSchema, rejection, {
		alwaysEmitImplicit: true,
	});
}

export function quoteResultFromJson(
	value: JsonValue,
): QuoteVector | PricingRejected | undefined {
	try {
		return fromJson(QuoteVectorSchema, value);
	} catch {
		try {
			return fromJson(PricingRejectedSchema, value);
		} catch {
			return undefined;
		}
	}
}
