import {
	DURABLE_MESSAGING_LIMITS,
	durableMessagingOperation,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { validUnknownEnvelope } from "../src/durable-messaging-conformance.js";
import { snapshotLimits } from "../src/durable-messaging-shapes.js";

describe("provider descriptor boundaries", () => {
	it("rejects inherited descriptors for missing outcome fields", () => {
		const operation = durableMessagingOperation(1000, "abcdefghijklmnop");
		let accepted = false;
		try {
			Object.defineProperty(Object.prototype, "status", {
				configurable: true,
				value: { value: "unknown", enumerable: true },
			});
			Object.defineProperty(Object.prototype, "operation", {
				configurable: true,
				value: { value: operation, enumerable: true },
			});
			accepted = validUnknownEnvelope({ unrelated: 1, extra: 2 }, operation);
		} finally {
			Reflect.deleteProperty(Object.prototype, "status");
			Reflect.deleteProperty(Object.prototype, "operation");
		}
		expect(accepted).toBe(false);
	});

	it("rejects accessors without reading inherited descriptor values", () => {
		let reads = 0;
		const limits = { ...DURABLE_MESSAGING_LIMITS };
		Object.defineProperty(limits, "nameBytes", {
			enumerable: true,
			get() {
				reads++;
				return 128;
			},
		});
		let accepted = false;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					reads++;
					return 128;
				},
			});
			try {
				snapshotLimits(limits);
				accepted = true;
			} catch {}
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
		}
		expect(accepted).toBe(false);
		expect(reads).toBe(0);
	});
});
