import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- SAFETY: this is the upstream protobuf type, locally aliased by its domain role. */
import {
	clone,
	type DescMessage,
	fromJson,
	type JsonValue as ProtobufJsonValue,
	type MessageShape as ProtoMessage,
	toJson,
} from "@bufbuild/protobuf";
/* oxlint-enable anti-slop/no-shape-in-symbol-names */
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
		if (
			typeof value !== "object" ||
			utilTypes.isProxy(value) ||
			ancestors.has(value)
		)
			return false;
		ancestors.add(value);
		try {
			const proto = Object.getPrototypeOf(value);
			if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
				return false;
			if (Array.isArray(value)) {
				if (proto !== Array.prototype) return false;
				if (value.length > 1024) return false;
			}
			if (Object.getOwnPropertySymbols(value).length !== 0) return false;
			const properties = Object.getOwnPropertyDescriptors(value);
			if (Array.isArray(value)) {
				if (Object.keys(properties).length !== value.length + 1) return false;
				for (let index = 0; index < value.length; index++) {
					if (!Object.hasOwn(properties, String(index))) return false;
				}
			}
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

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: these values are detached, bounded data inspected at the protobuf input boundary. */
export function isExactProtoMessage<Desc extends DescMessage>(
	schema: Desc,
	value: ProtoMessage<Desc>,
): boolean {
	if (!isBoundedPricingInput(value)) return false;
	try {
		const original = structuredClone(value);
		const copied = clone(schema, original);
		const equal = (left: unknown, right: unknown): boolean => {
			if (Object.is(left, right)) return true;
			if (
				typeof left !== "object" ||
				left === null ||
				typeof right !== "object" ||
				right === null ||
				Array.isArray(left) !== Array.isArray(right)
			)
				return false;
			if (
				Array.isArray(left) &&
				Array.isArray(right) &&
				left.length !== right.length
			)
				return false;
			const l = Object.getOwnPropertyDescriptors(left);
			const r = Object.getOwnPropertyDescriptors(right);
			const knownMessage =
				typeof l.$typeName?.value === "string" &&
				l.$typeName.value === r.$typeName?.value;
			const keys = (fields: PropertyDescriptorMap, array: boolean) =>
				Object.keys(fields)
					.filter((key) => {
						const field = fields[key];
						return (
							field !== undefined &&
							"value" in field &&
							!(
								knownMessage &&
								key === "$unknown" &&
								Array.isArray(field.value) &&
								field.value.length === 0
							) &&
							!(array && key === "length")
						);
					})
					.sort();
			const lk = keys(l, Array.isArray(left));
			const rk = keys(r, Array.isArray(right));
			if (lk.length !== rk.length || lk.some((key, index) => key !== rk[index]))
				return false;
			return lk.every((key) => equal(l[key]?.value, r[key]?.value));
		};
		return equal(original, copied);
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: JSON.parse is bounded by the caller; protobuf parsers refine values next. */
export function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

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
