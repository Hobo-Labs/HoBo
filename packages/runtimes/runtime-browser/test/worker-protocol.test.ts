/**
 * The RPC membrane between the UI thread and the SQLite worker.
 *
 * Everything crossing this boundary arrives as a `postMessage` payload — which
 * is to say, as `unknown` sent by whoever could reach the port. The two
 * functions here are the only thing standing between that and code which
 * assumes a well-formed request, so they are asymmetric on purpose:
 *
 * `parseBrowserStorageRequest` **throws**, because a malformed request is a
 * fault the worker must report rather than quietly drop — a dropped request is
 * a UI thread waiting on a reply that will never come.
 *
 * `isBrowserStorageResponse` **returns false**, because it runs on the UI
 * thread against messages from a shared channel where a message that is not a
 * storage response is ordinary, not an error.
 *
 * Both check `id`, since the id is what correlates a reply to its caller: an
 * unidentified message cannot be routed to the promise waiting on it.
 */

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
		// It is a narrowing parse, not a transform: the payload is already a
		// structured clone the worker owns.
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
		// The id is what routes the reply; without it the caller's promise never
		// settles.
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
		// A numeric id would compare unequal to the string key the caller
		// registered under.
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
		// The membrane checks shape; which ops exist is the dispatcher's
		// question, and duplicating that list here would let the two drift.
		expect(() =>
			parseBrowserStorageRequest({ id: "r1", op: "" }),
		).not.toThrow();
	});

	it("throws rather than returning, so a bad request is never dropped", () => {
		// A silently dropped request leaves the UI thread waiting forever.
		expect(() => parseBrowserStorageRequest({})).toThrow(TypeError);
	});
});

describe("isBrowserStorageResponse", () => {
	it("accepts a successful response", () => {
		expect(isBrowserStorageResponse({ id: "r1", ok: true })).toBe(true);
	});

	it("accepts a failed response", () => {
		// `ok: false` is still a response — refusing it would strand the caller
		// on exactly the messages it most needs.
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
		// Without it the caller cannot tell a result from an error, and would
		// resolve on both.
		expect(isBrowserStorageResponse({ id: "r1" })).toBe(false);
	});

	it("rejects a truthy non-boolean ok", () => {
		// `"true"` and `1` are the shapes a hand-rolled sender produces; treating
		// them as success would resolve a promise on an error payload.
		expect(isBrowserStorageResponse({ id: "r1", ok: "true" })).toBe(false);
		expect(isBrowserStorageResponse({ id: "r1", ok: 1 })).toBe(false);
	});

	it("returns false rather than throwing on a foreign message", () => {
		// It runs against a shared channel where non-storage traffic is ordinary.
		expect(() =>
			isBrowserStorageResponse({ type: "hmr-update" }),
		).not.toThrow();
		expect(isBrowserStorageResponse({ type: "hmr-update" })).toBe(false);
	});

	it("accepts an array only if it carries both fields", () => {
		// Arrays are objects; this documents which way that falls rather than
		// leaving it to be discovered.
		expect(isBrowserStorageResponse([])).toBe(false);
	});
});
