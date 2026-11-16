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

/** Bound work before traversing caller-supplied pricing trees or decoding them. */
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this is the untrusted input boundary; primitive type checks precede bounded traversal and protobuf parsing. */
export function isBoundedPricingInput<T>(input: T): boolean {
	let remaining = 25_000;
	const ancestors = new Set<object>();
	function visit<V>(value: V, depth: number): boolean {
		if (--remaining < 0 || depth > 48) return false;
		if (value === null || value === undefined || typeof value === "boolean")
			return true;
		if (typeof value === "string") return value.length <= 4096;
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "bigint") return value.toString().length <= 128;
		if (typeof value !== "object" || ancestors.has(value)) return false;
		ancestors.add(value);
		try {
			const proto = Object.getPrototypeOf(value);
			if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
				return false;
			if (Array.isArray(value) && value.length > 1024) return false;
			if (Object.getOwnPropertySymbols(value).length !== 0) return false;
			const properties = Object.getOwnPropertyDescriptors(value);
			for (const [key, descriptor] of Object.entries(properties)) {
				if (Array.isArray(value) && key === "length") continue;
				if (
					key.length > 200 ||
					!("value" in descriptor) ||
					!descriptor.enumerable ||
					!visit(descriptor.value, depth + 1)
				)
					return false;
			}
			return true;
		} finally {
			ancestors.delete(value);
		}
	}
	try {
		return visit(input, 0);
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

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
