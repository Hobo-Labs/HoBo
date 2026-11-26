import { describe, expect, it } from "vitest";
import {
	CRYPTOGRAPHY_CONTRACT,
	CRYPTOGRAPHY_MAX_INPUT_BYTES,
	parseCryptographyRequest,
} from "../src/ports/cryptography.js";

const attemptId = "crypto_attempt_123";

describe("cryptography requests", () => {
	it("captures only the requested byte view and owns its snapshot", () => {
		const backing = new Uint8Array([9, 1, 2, 3, 8]);
		const request = parseCryptographyRequest({
			attemptId,
			data: backing.subarray(1, 4),
		});
		backing.fill(0);
		expect([...request.data]).toEqual([1, 2, 3]);
		expect(request.attemptId).toBe(attemptId);
		expect(Object.getPrototypeOf(request)).toBeNull();
		expect(Object.isFrozen(request)).toBe(true);
		expect(CRYPTOGRAPHY_CONTRACT).toBe("hobo.cryptography/v1");
	});
	it("accepts bounded binary inputs and rejects empty or oversized data", () => {
		expect(
			parseCryptographyRequest({
				attemptId,
				data: new Uint8Array(CRYPTOGRAPHY_MAX_INPUT_BYTES),
			}).data.byteLength,
		).toBe(CRYPTOGRAPHY_MAX_INPUT_BYTES);
		for (const length of [0, CRYPTOGRAPHY_MAX_INPUT_BYTES + 1]) {
			expect(() =>
				parseCryptographyRequest({ attemptId, data: new Uint8Array(length) }),
			).toThrow("cryptography.invalid_request");
		}
	});
	it.each([
		{ attemptId: "short", data: new Uint8Array([1]) },
		{ attemptId: "a".repeat(65), data: new Uint8Array([1]) },
		{ attemptId, data: [1] },
		{ attemptId, data: new Uint16Array([1]) },
		{ attemptId, data: new Uint8Array(new SharedArrayBuffer(1)) },
		{ attemptId, data: new Uint8Array([1]), extra: true },
	])("rejects malformed input %#", (input) => {
		expect(() => parseCryptographyRequest(input)).toThrow(
			"cryptography.invalid_request",
		);
	});
	it("rejects accessors and proxies without invoking their traps", () => {
		let calls = 0;
		const accessor = Object.defineProperty({ attemptId }, "data", {
			enumerable: true,
			get() {
				calls++;
				return new Uint8Array([1]);
			},
		});
		const proxy = new Proxy(
			{ attemptId, data: new Uint8Array([1]) },
			{
				ownKeys() {
					calls++;
					return [];
				},
			},
		);
		expect(() => parseCryptographyRequest(accessor)).toThrow();
		expect(() => parseCryptographyRequest(proxy)).toThrow();
		expect(calls).toBe(0);
	});
	it("rejects detached byte views", () => {
		const data = new Uint8Array([1]);
		structuredClone(data, { transfer: [data.buffer] });
		expect(() => parseCryptographyRequest({ attemptId, data })).toThrow(
			"cryptography.invalid_request",
		);
	});
	it("does not read overridden byte-view accessors or iterators", () => {
		const data = new Uint8Array([3, 4]);
		Object.defineProperty(data, "byteLength", {
			get: () => {
				throw Error("getter");
			},
		});
		Object.defineProperty(data, Symbol.iterator, {
			value: () => {
				throw Error("iterator");
			},
		});
		expect([...parseCryptographyRequest({ attemptId, data }).data]).toEqual([
			3, 4,
		]);
	});
});
