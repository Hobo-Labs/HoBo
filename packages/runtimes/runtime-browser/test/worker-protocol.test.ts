import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import {
	isBrowserStorageResponse,
	parseBrowserStorageRequest,
} from "../src/worker-protocol.js";

describe("parseBrowserStorageRequest", () => {
	it("accepts a well-formed request", () => {
		expect(
			parseBrowserStorageRequest({ id: "r1", op: "append" }),
		).toMatchObject({ id: "r1", op: "append" });
	});

	it("returns the same object rather than a copy", () => {
		const request = { id: "r1", op: "append" };
		expect(parseBrowserStorageRequest(request)).toBe(request);
	});

	it("keeps the operation's own fields", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const parsed = parseBrowserStorageRequest({
			id: "r1",
			op: "append",
			stream: "yard",
		}) as JsonObject;
		expect(parsed.stream).toBe("yard");
	});

	it.each([
		null,
		undefined,
		7,
		"request",
		true,
	])("refuses the non-object payload %s", (raw) => {
		expect(() => parseBrowserStorageRequest(raw)).toThrow(TypeError);
	});

	it("refuses an array, which is an object but not a request", () => {
		expect(() => parseBrowserStorageRequest([])).toThrow(/must be an object/u);
	});

	it("refuses a request with no id", () => {
		expect(() => parseBrowserStorageRequest({ op: "append" })).toThrow(
			/id is required/u,
		);
	});

	it("refuses an empty id", () => {
		expect(() => parseBrowserStorageRequest({ id: "", op: "append" })).toThrow(
			/id is required/u,
		);
	});

	it("refuses a non-string id", () => {
		expect(() => parseBrowserStorageRequest({ id: 1, op: "append" })).toThrow(
			/id is required/u,
		);
	});

	it("refuses a request with no op", () => {
		expect(() => parseBrowserStorageRequest({ id: "r1" })).toThrow(
			/op is required/u,
		);
	});

	it("refuses a non-string op", () => {
		expect(() => parseBrowserStorageRequest({ id: "r1", op: 3 })).toThrow(
			/op is required/u,
		);
	});

	it("accepts an empty op string, leaving the dispatcher to reject it", () => {
		expect(() =>
			parseBrowserStorageRequest({ id: "r1", op: "" }),
		).not.toThrow();
	});

	it("throws rather than returning, so a bad request is never dropped", () => {
		expect(() => parseBrowserStorageRequest({})).toThrow(TypeError);
	});
});

describe("isBrowserStorageResponse", () => {
	it("accepts a successful response", () => {
		expect(isBrowserStorageResponse({ id: "r1", ok: true })).toBe(true);
	});

	it("accepts a failed response", () => {
		expect(isBrowserStorageResponse({ id: "r1", ok: false })).toBe(true);
	});

	it.each([
		null,
		undefined,
		7,
		"response",
		true,
	])("rejects the non-object value %s", (raw) => {
		expect(isBrowserStorageResponse(raw)).toBe(false);
	});

	it("rejects a message with no id", () => {
		expect(isBrowserStorageResponse({ ok: true })).toBe(false);
	});

	it("rejects a non-string id", () => {
		expect(isBrowserStorageResponse({ id: 1, ok: true })).toBe(false);
	});

	it("rejects a message with no ok flag", () => {
		expect(isBrowserStorageResponse({ id: "r1" })).toBe(false);
	});

	it("rejects a truthy non-boolean ok", () => {
		expect(isBrowserStorageResponse({ id: "r1", ok: "true" })).toBe(false);
		expect(isBrowserStorageResponse({ id: "r1", ok: 1 })).toBe(false);
	});

	it("returns false rather than throwing on a foreign message", () => {
		expect(() =>
			isBrowserStorageResponse({ type: "hmr-update" }),
		).not.toThrow();
		expect(isBrowserStorageResponse({ type: "hmr-update" })).toBe(false);
	});

	it("accepts an array only if it carries both fields", () => {
		expect(isBrowserStorageResponse([])).toBe(false);
	});
});
