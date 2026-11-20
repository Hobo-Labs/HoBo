import { types as utilTypes } from "node:util";

export const applyHostCallback = Reflect.apply;
export const hasOwnData = Object.hasOwn;
export const isRouteProxy = utilTypes.isProxy;

const MAX_ROUTE_BIGINT = 10n ** 128n - 1n;
const MIN_ROUTE_BIGINT = 1n - 10n ** 127n;

export const uninspectable = Symbol("uninspectable");

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: provider and host boundary values are inspected without invoking accessors or proxy traps. */
export function ownDataField(value: unknown, key: string): unknown {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			isRouteProxy(value) ||
			Array.isArray(value)
		)
			return uninspectable;
		let current: object | null = value;
		for (let depth = 0; depth <= 16; depth++) {
			if (current === null) return undefined;
			if (isRouteProxy(current)) return uninspectable;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (descriptor !== undefined)
				return depth === 0 && hasOwnData(descriptor, "value")
					? descriptor.value
					: uninspectable;
			current = Object.getPrototypeOf(current);
		}
		return uninspectable;
	} catch {
		return uninspectable;
	}
}

export function ownDataFields(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const field = ownDataField(value, key);
		if (field === uninspectable) return undefined;
		result[key] = field;
	}
	return result;
}

export function requiredOwnDataField(value: unknown, key: string): unknown {
	const result = ownDataField(value, key);
	if (result !== undefined) return result;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: ownDataField has already excluded null, proxies and inherited properties.
	return hasOwnData(value as object, key) ? undefined : uninspectable;
}

interface RouteValueLimits {
	readonly maxNodes: number;
	readonly maxStringLength: number;
	readonly maxArrayLength: number;
}

export function isBoundedRouteValue(
	input: unknown,
	limits: RouteValueLimits = {
		maxNodes: 100_000,
		maxStringLength: 1_048_576,
		maxArrayLength: 4096,
	},
): boolean {
	let nodes = limits.maxNodes;
	let textUnits = 4_000_000;
	const ancestors = new Set<object>();
	function visit(value: unknown, depth: number): boolean {
		if (--nodes < 0 || depth > 48) return false;
		if (value === null || value === undefined || typeof value === "boolean")
			return true;
		if (typeof value === "string") {
			textUnits -= value.length;
			return value.length <= limits.maxStringLength && textUnits >= 0;
		}
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "bigint")
			return value >= MIN_ROUTE_BIGINT && value <= MAX_ROUTE_BIGINT;
		if (
			typeof value !== "object" ||
			isRouteProxy(value) ||
			ancestors.has(value)
		)
			return false;
		ancestors.add(value);
		try {
			const array = Array.isArray(value);
			const prototype = Object.getPrototypeOf(value);
			if (
				array
					? prototype !== Array.prototype
					: prototype !== Object.prototype && prototype !== null
			)
				return false;
			if (array && value.length > limits.maxArrayLength) return false;
			const keys = Reflect.ownKeys(value);
			if (array && keys.length !== value.length + 1) return false;
			for (const key of keys) {
				if (typeof key !== "string") return false;
				if (array && key === "length") continue;
				textUnits -= key.length;
				const field = Object.getOwnPropertyDescriptor(value, key);
				if (
					key.length > 200 ||
					textUnits < 0 ||
					!field?.enumerable ||
					!hasOwnData(field, "value") ||
					!visit(field.value, depth + 1)
				)
					return false;
			}
			if (array)
				for (let index = 0; index < value.length; index++)
					if (!hasOwnData(value, String(index))) return false;
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
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
