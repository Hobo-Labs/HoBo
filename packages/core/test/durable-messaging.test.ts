import { describe, expect, it } from "vitest";
import {
	DURABLE_MESSAGING_LIMITS,
	durableMessagingOperation,
	parseDurableMessagingLeaseId,
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

	it("does not use inherited descriptor fields to construct an operation", () => {
		const id = "v1.1.nonce_1234567890";
		const input = { unrelated: true, other: true };
		let accepted = false;
		try {
			Object.defineProperty(Object.prototype, "id", {
				configurable: true,
				value: { value: id, enumerable: true },
			});
			Object.defineProperty(Object.prototype, "expiresAtMs", {
				configurable: true,
				value: { value: 1, enumerable: true },
			});
			try {
				parseDurableMessagingOperation(input);
				accepted = true;
			} catch {}
		} finally {
			Reflect.deleteProperty(Object.prototype, "id");
			Reflect.deleteProperty(Object.prototype, "expiresAtMs");
		}
		expect(accepted).toBe(false);
	});

	it("does not read inherited values on accessor descriptors", () => {
		const input = {
			id: "v1.1.nonce_1234567890",
			get expiresAtMs() {
				throw new Error("unexpected own getter");
			},
		};
		let reads = 0;
		let accepted = false;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					reads++;
					return 1;
				},
			});
			try {
				parseDurableMessagingOperation(input);
				accepted = true;
			} catch {}
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
		}
		expect(accepted).toBe(false);
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

describe("durable messaging lease identity", () => {
	it("uses the actual provider name limit in UTF-8 bytes", () => {
		expect(parseDurableMessagingLeaseId("lease-1", 7)).toBe("lease-1");
		expect(parseDurableMessagingLeaseId("éé", 4)).toBe("éé");
		expect(parseDurableMessagingLeaseId("😀", 4)).toBe("😀");
		expect(() => parseDurableMessagingLeaseId("éé", 3)).toThrow();
		expect(() => parseDurableMessagingLeaseId("lease-1", 6)).toThrow();
	});

	it.each([
		"",
		"lease\u0000id",
		"lease\u007fid",
		"lease\u0080id",
		"\ud800",
		"\udc00",
	])("rejects empty, control or non-scalar lease IDs", (value) => {
		expect(() => parseDurableMessagingLeaseId(value, 128)).toThrow();
	});

	it.each([
		0,
		-1,
		129,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid advertised limits", (limit) => {
		expect(() => parseDurableMessagingLeaseId("lease", limit)).toThrow();
	});
});
