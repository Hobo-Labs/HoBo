/**
 * The JSON boundary helpers.
 *
 * `src/json.ts` is byte-identical in 38 packages — the package-boundary lint
 * forbids adapter→adapter imports, so each adapter carries its own copy rather
 * than reaching sideways for one. That makes it *this* package's code for
 * coverage purposes even though this package calls two or three of its ten
 * exports, which is why an untested copy drags a whole package under its floor.
 *
 * This file therefore tests the module rather than this package's use of it.
 *
 * **Every predicate goes through `Object.prototype.toString`, not `typeof`.**
 * That is the deliberate part: `typeof new String("x")` is `"object"`, so a
 * boxed primitive would slip past a `typeof` check and then fail to serialize
 * the way its caller expects. The tag test treats boxed and bare alike.
 *
 * **`isJsonObject` is the one that cannot be a bare tag test.** `null` and
 * arrays both need excluding — `null` because `typeof null === "object"` is the
 * oldest trap in the language, and arrays because a JSON array is a different
 * branch of `JsonValue` with different handling downstream.
 *
 * **Parsing never throws.** `parseJsonValue` answers `null` and
 * `parseJsonObject` answers `{}` on malformed input. These sit at document
 * boundaries where the input is a file or a network body, so a throw would make
 * every caller wrap them; the empty answer is the contract.
 *
 * **`isJsonBigInt` exists for a type that `JsonValue` does not contain.** It is
 * there so callers can *detect* a bigint and convert it before serializing —
 * `JSON.stringify` throws on one — rather than to admit it as JSON.
 */
import { describe, expect, it } from "vitest";

import {
	asJsonObject,
	cloneAsJson,
	isJsonArray,
	isJsonBigInt,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonObject,
	parseJsonValue,
} from "../src/json.js";

describe("recognising a string", () => {
	it("accepts a bare string", () => {
		expect(isJsonString("hello")).toBe(true);
	});

	it("accepts a boxed String", () => {
		// The reason these use `Object.prototype.toString` rather than `typeof`:
		// `typeof new String("x")` is "object", so a boxed primitive would slip
		// past a typeof check and surprise whatever serialized it later.
		expect(isJsonString(new String("hello"))).toBe(true);
	});

	it.each([
		["a number", 1],
		["null", null],
		["undefined", undefined],
		["an array", ["hello"]],
		["an object", { value: "hello" }],
	])("refuses %s", (_label, value) => {
		expect(isJsonString(value)).toBe(false);
	});
});

describe("recognising a number", () => {
	it("accepts a bare number", () => {
		expect(isJsonNumber(42)).toBe(true);
	});

	it("accepts a boxed Number", () => {
		expect(isJsonNumber(new Number(42))).toBe(true);
	});

	it("accepts NaN", () => {
		// NaN *is* a number by tag, and this predicate does not claim otherwise.
		// Recorded because `JSON.stringify(NaN)` is "null", so a caller that needs
		// a finite value has to check for that itself — this is not the guard.
		expect(isJsonNumber(Number.NaN)).toBe(true);
	});

	it("accepts Infinity", () => {
		expect(isJsonNumber(Number.POSITIVE_INFINITY)).toBe(true);
	});

	it("refuses a numeric string", () => {
		expect(isJsonNumber("42")).toBe(false);
	});

	it("refuses a bigint", () => {
		expect(isJsonNumber(1n)).toBe(false);
	});
});

describe("recognising a boolean", () => {
	it.each([true, false])("accepts %s", (value) => {
		expect(isJsonBoolean(value)).toBe(true);
	});

	it("refuses a boxed Boolean", () => {
		// The one predicate that is an identity test rather than a tag test, so
		// unlike its siblings it does *not* accept the boxed form. Recorded
		// because the asymmetry is surprising and load-bearing: `new Boolean(false)`
		// is truthy, so treating it as JSON `false` would invert a condition.
		expect(isJsonBoolean(new Boolean(false))).toBe(false);
	});

	it.each([
		["zero", 0],
		["one", 1],
		["an empty string", ""],
		["null", null],
	])("refuses %s", (_label, value) => {
		expect(isJsonBoolean(value)).toBe(false);
	});
});

describe("recognising an object", () => {
	it("accepts a plain object", () => {
		expect(isJsonObject({ a: 1 })).toBe(true);
	});

	it("accepts an empty object", () => {
		expect(isJsonObject({})).toBe(true);
	});

	it("refuses null", () => {
		// `typeof null === "object"` is the oldest trap in the language, and this
		// predicate guards a boundary where mistaking null for a record means
		// reading properties off it.
		expect(isJsonObject(null)).toBe(false);
	});

	it("refuses undefined", () => {
		expect(isJsonObject(undefined)).toBe(false);
	});

	it("refuses an array", () => {
		// A JSON array is a different branch of `JsonValue` with different
		// handling downstream, so it must not answer to the object predicate.
		expect(isJsonObject([1, 2])).toBe(false);
	});

	it("refuses a Date", () => {
		// Tags as "[object Date]". It survives `JSON.stringify` as a string, so a
		// caller treating it as a record would find no properties at all.
		expect(isJsonObject(new Date(0))).toBe(false);
	});

	it("refuses a Map", () => {
		expect(isJsonObject(new Map())).toBe(false);
	});

	it("accepts an object with no prototype", () => {
		// `Object.create(null)` still tags as "[object Object]", which is what a
		// parsed-with-a-reviver document can look like.
		expect(isJsonObject(Object.create(null))).toBe(true);
	});
});

describe("recognising an array", () => {
	it("accepts an array", () => {
		expect(isJsonArray([1, 2])).toBe(true);
	});

	it("accepts an empty array", () => {
		expect(isJsonArray([])).toBe(true);
	});

	it.each([
		["an object", { 0: 1 }],
		["a string", "12"],
		["null", null],
	])("refuses %s", (_label, value) => {
		expect(isJsonArray(value)).toBe(false);
	});
});

describe("recognising a bigint", () => {
	it("accepts a bigint", () => {
		// `JsonValue` has no bigint arm, and that is the point: this exists so a
		// caller can *detect* one and convert it before serializing, because
		// `JSON.stringify` throws on a bigint rather than degrading.
		expect(isJsonBigInt(1n)).toBe(true);
	});

	it("refuses a number", () => {
		expect(isJsonBigInt(1)).toBe(false);
	});

	it("refuses a numeric string", () => {
		expect(isJsonBigInt("1")).toBe(false);
	});
});

describe("cloning across the document boundary", () => {
	it("returns an equal value", () => {
		expect(cloneAsJson({ a: [1, "two", null] })).toEqual({
			a: [1, "two", null],
		});
	});

	it("returns a copy rather than the original", () => {
		// The whole point of the call: a document that shares structure with the
		// domain object it came from lets a later mutation rewrite history.
		const source = { nested: { value: 1 } };
		const clone = cloneAsJson(source);
		expect(clone).not.toBe(source);
		// SAFETY: the clone of an object literal is an object.
		expect((clone as { nested: unknown }).nested).not.toBe(source.nested);
	});

	it("turns undefined into null", () => {
		// `?? null` before stringify. Without it `JSON.stringify(undefined)` is
		// itself `undefined` — not a string — and the parse below would fail.
		expect(cloneAsJson(undefined)).toBeNull();
	});

	it("turns null into null", () => {
		expect(cloneAsJson(null)).toBeNull();
	});

	it("drops undefined properties, as JSON does", () => {
		expect(cloneAsJson({ kept: 1, dropped: undefined })).toEqual({ kept: 1 });
	});

	it("renders a Date as its ISO string", () => {
		expect(cloneAsJson(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
	});

	it("keeps a nested empty object", () => {
		expect(cloneAsJson({ a: {} })).toEqual({ a: {} });
	});
});

describe("parsing a value", () => {
	it.each([
		["an object", '{"a":1}', { a: 1 }],
		["an array", "[1,2]", [1, 2]],
		["a string", '"text"', "text"],
		["a number", "42", 42],
		["true", "true", true],
		["null", "null", null],
	])("parses %s", (_label, text, expected) => {
		expect(parseJsonValue(text)).toEqual(expected);
	});

	it.each([
		["malformed input", "{oops"],
		["an empty string", ""],
		["a bare word", "text"],
	])("answers null for %s", (_label, text) => {
		// Never throws: this sits at a document boundary where the input is a file
		// or a network body, so a throw would make every caller wrap it.
		expect(parseJsonValue(text)).toBeNull();
	});
});

describe("parsing an object", () => {
	it("parses an object", () => {
		expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
	});

	it.each([
		["malformed input", "{oops"],
		["an empty string", ""],
		["a JSON array", "[1,2]"],
		["a JSON string", '"text"'],
		["JSON null", "null"],
		["a JSON number", "42"],
	])("answers an empty object for %s", (_label, text) => {
		// The empty object is the contract, and it covers both "could not parse"
		// and "parsed to something that is not a record". A caller that needs to
		// tell those apart uses `parseJsonValue` and checks.
		expect(parseJsonObject(text)).toEqual({});
	});
});

describe("coercing to an object", () => {
	it("keeps an object", () => {
		expect(asJsonObject({ a: 1 })).toEqual({ a: 1 });
	});

	it.each([
		["an array", [1, 2]],
		["a string", "text"],
		["a number", 42],
		["null", null],
		["undefined", undefined],
	])("answers an empty object for %s", (_label, value) => {
		expect(asJsonObject(value)).toEqual({});
	});

	it("clones on the way through", () => {
		const source = { nested: { value: 1 } };
		expect(asJsonObject(source).nested).not.toBe(source.nested);
	});
});
