/**
 * The JSON guards atom parsing branches on. They answer what `typeof` would:
 * only a primitive is a string, so a boxed `String` and an object spoofing
 * `Symbol.toStringTag` are not, and only a non-array, non-function object is
 * an object.
 */
import { describe, expect, it } from "vitest";

import { isJsonArray, isJsonObject, isJsonString } from "../src/json.js";

const spoofedString = { [Symbol.toStringTag]: "String" };
const spoofedArray = { [Symbol.toStringTag]: "Array" };

describe("isJsonString", () => {
	it("accepts a primitive string, empty included", () => {
		expect(isJsonString("probe")).toBe(true);
		expect(isJsonString("")).toBe(true);
	});

	it("rejects a boxed String and a spoofed tag", () => {
		expect(isJsonString(new String("probe"))).toBe(false);
		expect(isJsonString(spoofedString)).toBe(false);
	});

	it("rejects every other kind", () => {
		for (const value of [
			null,
			undefined,
			0,
			true,
			["probe"],
			{},
			Symbol("s"),
		]) {
			expect(isJsonString(value)).toBe(false);
		}
	});
});

describe("isJsonObject", () => {
	it("accepts a plain object", () => {
		expect(isJsonObject({})).toBe(true);
		expect(isJsonObject(spoofedString)).toBe(true);
	});

	it("rejects null, arrays, functions and primitives", () => {
		for (const value of [null, undefined, [], () => 1, "probe", 7, false]) {
			expect(isJsonObject(value)).toBe(false);
		}
	});
});

describe("isJsonArray", () => {
	it("accepts an array and rejects a spoofed tag", () => {
		expect(isJsonArray([])).toBe(true);
		expect(isJsonArray(spoofedArray)).toBe(false);
		expect(isJsonArray({ length: 0 })).toBe(false);
	});
});
