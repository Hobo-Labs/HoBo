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
		expect(isJsonObject(null)).toBe(false);
	});

	it("refuses undefined", () => {
		expect(isJsonObject(undefined)).toBe(false);
	});

	it("refuses an array", () => {
		expect(isJsonObject([1, 2])).toBe(false);
	});

	it("refuses a Date", () => {
		expect(isJsonObject(new Date(0))).toBe(false);
	});

	it("refuses a Map", () => {
		expect(isJsonObject(new Map())).toBe(false);
	});

	it("accepts an object with no prototype", () => {
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
		const source = { nested: { value: 1 } };
		const clone = cloneAsJson(source);
		expect(clone).not.toBe(source);

		if (!isJsonObject(clone)) throw new TypeError("clone must be an object");
		expect(clone.nested).not.toBe(source.nested);
	});

	it("turns undefined into null", () => {
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
