/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: this legacy provider-selection parser intentionally accepts and recursively canonicalizes untyped JSON options. */
import type { ProviderSelection } from "./types.js";

export function providerSelection(
	providerId: string,
	selector = "default",
	options: Readonly<Record<string, unknown>> = {},
): ProviderSelection {
	requireName("providerId", providerId);
	requireName("selector", selector);
	if (!isPlainObject(options)) {
		throw new TypeError("provider selection options must be an object");
	}

	return deepFreeze({
		kind: "provider-selection",
		providerId,
		selector,
		options: sortKeys(options) as Readonly<Record<string, unknown>>,
	});
}

function requireName(label: string, value: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (!isPlainObject(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys(value[key])]),
	);
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}
