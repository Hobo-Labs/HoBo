import { types as utilTypes } from "node:util";

/** Capture the intrinsic before invoking any caller-owned callbacks. */
export const applyHostCallback = Reflect.apply;

/** Marks a field that cannot be read without executing caller-owned code. */
export const uninspectable = Symbol("uninspectable");

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: provider and host boundary values are inspected without invoking accessors or proxy traps. */
export function ownDataField(value: unknown, key: string): unknown {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			utilTypes.isProxy(value) ||
			Array.isArray(value)
		)
			return uninspectable;
		let current: object | null = value;
		for (let depth = 0; depth <= 16; depth++) {
			if (current === null) return undefined;
			if (utilTypes.isProxy(current)) return uninspectable;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (descriptor !== undefined)
				return depth === 0 && "value" in descriptor
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
	const result: Record<string, unknown> = {};
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
	// SAFETY: ownDataField has already excluded null, proxies and inherited properties.
	return Object.hasOwn(value as object, key) ? undefined : uninspectable;
}

/** Check a generic route value before cloning; aliases consume the budget repeatedly. */
export function isBoundedRouteValue(input: unknown): boolean {
	let nodes = 100_000;
	let textUnits = 4_000_000;
	const ancestors = new Set<object>();
	function visit(value: unknown, depth: number): boolean {
		if (--nodes < 0 || depth > 48) return false;
		if (value === null || value === undefined || typeof value === "boolean")
			return true;
		if (typeof value === "string") {
			textUnits -= value.length;
			return value.length <= 1_048_576 && textUnits >= 0;
		}
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
			const array = Array.isArray(value);
			const prototype = Object.getPrototypeOf(value);
			if (
				array
					? prototype !== Array.prototype
					: prototype !== Object.prototype && prototype !== null
			)
				return false;
			if (array && value.length > 4096) return false;
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
					!("value" in field) ||
					!visit(field.value, depth + 1)
				)
					return false;
			}
			if (array)
				for (let index = 0; index < value.length; index++)
					if (!Object.hasOwn(value, String(index))) return false;
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
