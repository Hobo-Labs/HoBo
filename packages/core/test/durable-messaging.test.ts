import { describe, expect, it } from "vitest";
import {
	DURABLE_MESSAGING_LIMITS,
	durableMessagingOperation,
	parseDurableMessagingOperation,
} from "../src/ports/durable-messaging.js";

describe("durable messaging operation identity", () => {
	it("binds a canonical absolute expiry to an immutable operation ID", () => {
		const operation = durableMessagingOperation(
			1_700_000_000_123,
			"nonce_1234567890",
		);
		expect(operation).toEqual({
			id: "v1.1700000000123.nonce_1234567890",
			expiresAtMs: 1_700_000_000_123,
		});
		expect(Object.isFrozen(operation)).toBe(true);
		const input = { ...operation };
		const snapshot = parseDurableMessagingOperation(input);
		input.expiresAtMs++;
		expect(snapshot).toEqual(operation);
		expect(() => parseDurableMessagingOperation(input)).toThrow();
	});

	it.each([
		{ id: "v1.0001.nonce_1234567890", expiresAtMs: 1 },
		{ id: "v1.1.nonce_1234567890", expiresAtMs: 2 },
		{ id: "v1.1.short", expiresAtMs: 1 },
		{ id: `v1.1.${"a".repeat(65)}`, expiresAtMs: 1 },
		{ id: "v1.1.nonce_1234567890", expiresAtMs: -1 },
		{ id: "v1.1.nonce_1234567890", expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
		{ id: "v1.1.nonce_1234567890", expiresAtMs: 1, extra: true },
	])("refuses malformed, altered or noncanonical expiry-bound IDs", (input) => {
		expect(() => parseDurableMessagingOperation(input)).toThrow(
			"invalid durable messaging operation",
		);
	});

	it("rejects accessors without executing them", () => {
		let reads = 0;
		const input = {
			id: "v1.1.nonce_1234567890",
			get expiresAtMs() {
				reads++;
				return 1;
			},
		};
		expect(() => parseDurableMessagingOperation(input)).toThrow();
		expect(reads).toBe(0);
	});

	it("bounds operation IDs independently from provider name limits", () => {
		const longest = durableMessagingOperation(
			Number.MAX_SAFE_INTEGER,
			"a".repeat(64),
		);
		expect(longest.id.length).toBe(84);
		expect(parseDurableMessagingOperation(longest)).toEqual(longest);
		expect(
			durableMessagingOperation(1, "a".repeat(16)).id.length,
		).toBeGreaterThan(16);
	});

	it("declares immutable, finite bounds", () => {
		expect(Object.isFrozen(DURABLE_MESSAGING_LIMITS)).toBe(true);
		for (const value of Object.values(DURABLE_MESSAGING_LIMITS)) {
			expect(Number.isSafeInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});
