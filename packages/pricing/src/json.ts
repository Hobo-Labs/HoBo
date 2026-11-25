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
const hasOwn = Object.hasOwn;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyNames = Object.getOwnPropertyNames;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const ownKeys = Object.keys;
const ownEntries = Object.entries;
const isArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const objectConstructor = Object;
const arrayConstructor = Array;
const cloneData = structuredClone;
const globalObject = globalThis;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const pricingGlobals = [
	["Object", objectConstructor],
	["Array", arrayConstructor],
	["structuredClone", cloneData],
] as const;
const pricingReflection = [
	["hasOwn", hasOwn],
	["getPrototypeOf", getPrototypeOf],
	["getOwnPropertyNames", getOwnPropertyNames],
	["getOwnPropertySymbols", getOwnPropertySymbols],
	["getOwnPropertyDescriptor", getOwnPropertyDescriptor],
	["getOwnPropertyDescriptors", getOwnPropertyDescriptors],
	["keys", ownKeys],
	["entries", ownEntries],
] as const;

const PRICING_BIGINT_UPPER_BOUND = 10n ** 128n;
const PRICING_BIGINT_LOWER_BOUND = -(10n ** 127n);

const PRICING_OBJECT_PROTOTYPE_KEYS = [
	"constructor",
	"__defineGetter__",
	"__defineSetter__",
	"hasOwnProperty",
	"__lookupGetter__",
	"__lookupSetter__",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toString",
	"valueOf",
	"toLocaleString",
] as const;
const pricingObjectPrototype = getOwnPropertyDescriptors(objectPrototype);
const legacyProto = hasOwn(pricingObjectPrototype, "__proto__");

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the trusted realm and intrinsic descriptors must be checked before pricing traverses input. */
export function isSupportedPricingRealm(): boolean {
	try {
		for (const [name, expected] of pricingGlobals) {
			const actual = getOwnPropertyDescriptor(globalObject, name);
			if (
				actual === undefined ||
				!hasOwn(actual, "value") ||
				actual.value !== expected
			)
				return false;
		}
		for (const [name, expected] of pricingReflection) {
			const actual = getOwnPropertyDescriptor(objectConstructor, name);
			if (
				actual === undefined ||
				!hasOwn(actual, "value") ||
				actual.value !== expected
			)
				return false;
		}
		const arrayCheck = getOwnPropertyDescriptor(arrayConstructor, "isArray");
		if (
			arrayCheck === undefined ||
			!hasOwn(arrayCheck, "value") ||
			arrayCheck.value !== isArray
		)
			return false;
		const currentLegacyProto = hasOwn(objectPrototype, "__proto__");
		if (
			(currentLegacyProto && !legacyProto) ||
			getPrototypeOf(objectPrototype) !== null ||
			getOwnPropertyNames(objectPrototype).length !==
				PRICING_OBJECT_PROTOTYPE_KEYS.length + (currentLegacyProto ? 1 : 0) ||
			getOwnPropertySymbols(objectPrototype).length !== 0
		)
			return false;
		for (const key of [
			...PRICING_OBJECT_PROTOTYPE_KEYS,
			...(currentLegacyProto ? ["__proto__"] : []),
		]) {
			if (!hasOwn(pricingObjectPrototype, key)) return false;
			const expected = pricingObjectPrototype[key];
			const actual = getOwnPropertyDescriptor(objectPrototype, key);
			if (
				expected === undefined ||
				actual === undefined ||
				expected.enumerable !== false ||
				actual.enumerable !== false ||
				(actual.configurable && !expected.configurable)
			)
				return false;
			if (!hasOwn(expected, "value")) {
				if (
					hasOwn(actual, "value") ||
					!hasOwn(actual, "get") ||
					!hasOwn(actual, "set") ||
					!hasOwn(expected, "get") ||
					!hasOwn(expected, "set") ||
					typeof actual.get !== "function" ||
					typeof actual.set !== "function" ||
					actual.get !== expected.get ||
					actual.set !== expected.set ||
					isProxy(actual.get) ||
					isProxy(actual.set)
				)
					return false;
			} else if (
				!hasOwn(actual, "value") ||
				!hasOwn(expected, "value") ||
				(actual.writable && !expected.writable) ||
				typeof actual.value !== "function" ||
				isProxy(actual.value) ||
				actual.value !== expected.value
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this is the untrusted input boundary; primitive type checks precede bounded traversal and protobuf parsing. */
export function isBoundedPricingInput<T>(input: T): boolean {
	return inspectPricingInput(input, 25_000, Number.POSITIVE_INFINITY);
}

export function areBoundedPricingInputs<T>(inputs: readonly T[]): boolean {
	return inspectPricingInput(inputs, 100_000, 4_000_000);
}

function inspectPricingInput<T>(
	input: T,
	nodeLimit: number,
	textUnitLimit: number,
): boolean {
	if (!isSupportedPricingRealm()) return false;
	let remaining = nodeLimit;
	let textUnits = textUnitLimit;
	const ancestors = new Set<object>();
	function visit<V>(value: V, depth: number): boolean {
		if (--remaining < 0 || depth > 48) return false;
		if (value === null || value === undefined || typeof value === "boolean")
			return true;
		if (typeof value === "string") {
			textUnits -= value.length;
			return value.length <= 4096 && textUnits >= 0;
		}
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "bigint")
			return (
				value > PRICING_BIGINT_LOWER_BOUND && value < PRICING_BIGINT_UPPER_BOUND
			);
		if (typeof value !== "object" || isProxy(value) || ancestors.has(value))
			return false;
		ancestors.add(value);
		try {
			const proto = getPrototypeOf(value);
			if (
				isArray(value)
					? proto !== arrayPrototype
					: proto !== objectPrototype && proto !== null
			)
				return false;
			if (isArray(value) && value.length > 1024) return false;
			if (getOwnPropertySymbols(value).length !== 0) return false;
			const properties = getOwnPropertyDescriptors(value);
			if (isArray(value)) {
				if (ownKeys(properties).length !== value.length + 1) return false;
				for (let index = 0; index < value.length; index++) {
					if (!hasOwn(properties, String(index))) return false;
				}
			}
			for (const [key, descriptor] of ownEntries(properties)) {
				if (isArray(value) && key === "length") continue;
				textUnits -= key.length;
				if (
					key.length > 200 ||
					textUnits < 0 ||
					!hasOwn(descriptor, "value") ||
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
		const original = cloneData(value);
		const copied = clone(schema, original);
		const equal = (left: unknown, right: unknown): boolean => {
			if (Object.is(left, right)) return true;
			if (
				typeof left !== "object" ||
				left === null ||
				typeof right !== "object" ||
				right === null ||
				isArray(left) !== isArray(right)
			)
				return false;
			if (isArray(left) && isArray(right) && left.length !== right.length)
				return false;
			const l = getOwnPropertyDescriptors(left);
			const r = getOwnPropertyDescriptors(right);
			const leftType = hasOwn(l, "$typeName") ? l.$typeName : undefined;
			const rightType = hasOwn(r, "$typeName") ? r.$typeName : undefined;
			const knownMessage =
				leftType !== undefined &&
				rightType !== undefined &&
				hasOwn(leftType, "value") &&
				hasOwn(rightType, "value") &&
				typeof leftType.value === "string" &&
				leftType.value === rightType.value;
			const keys = (fields: PropertyDescriptorMap, array: boolean) =>
				ownKeys(fields)
					.filter((key) => {
						const field = fields[key];
						return (
							field !== undefined &&
							hasOwn(field, "value") &&
							!(
								knownMessage &&
								key === "$unknown" &&
								isArray(field.value) &&
								field.value.length === 0
							) &&
							!(array && key === "length")
						);
					})
					.sort();
			const lk = keys(l, isArray(left));
			const rk = keys(r, isArray(right));
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

export function parseJson(text: string): JsonValue | undefined {
	if (!isSupportedPricingRealm()) return undefined;
	try {
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
	if (!isSupportedPricingRealm())
		throw new TypeError("unsupported pricing prototype environment");
	return JSON.stringify(sortJson(value));
}

export function stableHash(value: JsonValue): string {
	return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function parseQuoteScenario(
	value: JsonValue,
): QuoteScenario | undefined {
	if (!isBoundedPricingInput(value)) return undefined;
	try {
		return fromJson(QuoteScenarioSchema, value);
	} catch {
		return undefined;
	}
}

export function quoteScenarioToJson(scenario: QuoteScenario): JsonValue {
	if (!isSupportedPricingRealm())
		throw new TypeError("unsupported pricing prototype environment");
	return toJson(QuoteScenarioSchema, scenario, { alwaysEmitImplicit: true });
}

export function quoteVectorToJson(vector: QuoteVector): JsonValue {
	if (!isSupportedPricingRealm())
		throw new TypeError("unsupported pricing prototype environment");
	return toJson(QuoteVectorSchema, vector, { alwaysEmitImplicit: true });
}

export function pricingRejectedToJson(rejection: PricingRejected): JsonValue {
	if (!isSupportedPricingRealm())
		throw new TypeError("unsupported pricing prototype environment");
	return toJson(PricingRejectedSchema, rejection, {
		alwaysEmitImplicit: true,
	});
}

export function quoteResultFromJson(
	value: JsonValue,
): QuoteVector | PricingRejected | undefined {
	if (!isSupportedPricingRealm()) return undefined;
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
