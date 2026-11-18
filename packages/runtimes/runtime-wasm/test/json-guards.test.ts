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

describe("isJsonString", () => {
	it("accepts a string", () => {
		expect(isJsonString("a")).toBe(true);
	});

	it("accepts the empty string", () => {
		expect(isJsonString("")).toBe(true);
	});

	it("refuses a number, a boolean, null and undefined", () => {
		expect(
			[1, true, null, undefined].map((v) => isJsonString(v)),
		).toStrictEqual([false, false, false, false]);
	});

	it("refuses an object with a toString", () => {
		expect(isJsonString({ toString: () => "a" })).toBe(false);
	});

	it("refuses a boxed String", () => {
		expect(isJsonString(new String("a"))).toBe(false);
	});
});

describe("isJsonNumber", () => {
	it("accepts an integer, a float, zero and a negative", () => {
		expect([1, 1.5, 0, -3].map((v) => isJsonNumber(v))).toStrictEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it("refuses a numeric string", () => {
		expect(isJsonNumber("1")).toBe(false);
	});

	it("refuses a bigint", () => {
		expect(isJsonNumber(1n)).toBe(false);
	});

	it("refuses non-finite and boxed numbers", () => {
		expect(isJsonNumber(Number.NaN)).toBe(false);
		expect(isJsonNumber(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isJsonNumber(Number.NEGATIVE_INFINITY)).toBe(false);
		expect(isJsonNumber(new Number(1))).toBe(false);
	});
});

describe("isJsonBigInt", () => {
	it("accepts a bigint", () => {
		expect(isJsonBigInt(1n)).toBe(true);
	});

	it("refuses a number", () => {
		expect(isJsonBigInt(1)).toBe(false);
	});

	it("refuses a boxed bigint", () => {
		expect(isJsonBigInt(Object(1n))).toBe(false);
	});
});

describe("isJsonBoolean", () => {
	it("accepts both booleans", () => {
		expect([isJsonBoolean(true), isJsonBoolean(false)]).toStrictEqual([
			true,
			true,
		]);
	});

	it("refuses truthy and falsy non-booleans", () => {
		expect(
			[0, 1, "", "true", null, undefined].map((v) => isJsonBoolean(v)),
		).toStrictEqual([false, false, false, false, false, false]);
	});

	it("refuses a boxed Boolean", () => {
		expect(isJsonBoolean(new Boolean(false))).toBe(false);
	});
});

describe("isJsonObject", () => {
	it("accepts a plain object and an empty one", () => {
		expect([isJsonObject({ a: 1 }), isJsonObject({})]).toStrictEqual([
			true,
			true,
		]);
	});

	it("refuses null", () => {
		expect(isJsonObject(null)).toBe(false);
	});

	it("refuses undefined", () => {
		expect(isJsonObject(undefined)).toBe(false);
	});

	it("refuses an array", () => {
		expect([isJsonObject([]), isJsonObject([1, 2])]).toStrictEqual([
			false,
			false,
		]);
	});

	it("refuses a Date, a Map and a RegExp", () => {
		expect(
			[new Date(), new Map(), /x/].map((v) => isJsonObject(v)),
		).toStrictEqual([false, false, false]);
	});

	it("accepts a null-prototype object", () => {
		expect(isJsonObject(Object.create(null))).toBe(true);
	});

	it("accepts a class instance", () => {
		class Descriptor {
			readonly id = "a";
		}
		expect(isJsonObject(new Descriptor())).toBe(true);
	});
});

describe("isJsonArray", () => {
	it("accepts an array, empty or not", () => {
		expect([isJsonArray([]), isJsonArray([1])]).toStrictEqual([true, true]);
	});

	it("refuses an object, a string and null", () => {
		expect([{}, "ab", null].map((v) => isJsonArray(v))).toStrictEqual([
			false,
			false,
			false,
		]);
	});
});

describe("cloneAsJson", () => {
	it("turns undefined into null", () => {
		expect(cloneAsJson(undefined)).toBeNull();
	});

	it("preserves null", () => {
		expect(cloneAsJson(null)).toBeNull();
	});

	it("round-trips scalars and arrays", () => {
		expect([
			cloneAsJson("a"),
			cloneAsJson(1),
			cloneAsJson(false),
		]).toStrictEqual(["a", 1, false]);
		expect(cloneAsJson([1, "a"])).toStrictEqual([1, "a"]);
	});

	it("returns a value that does not share references with its source", () => {
		const source = { nested: { list: [1] } };
		const clone = cloneAsJson(source);
		source.nested.list.push(2);
		expect(clone).toStrictEqual({ nested: { list: [1] } });
	});

	it("drops methods and the prototype", () => {
		class Descriptor {
			readonly id = "a";
			render() {
				return this.id;
			}
		}
		const clone = cloneAsJson(new Descriptor());
		expect(clone).toStrictEqual({ id: "a" });
		expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
	});

	it("drops undefined properties rather than nulling them", () => {
		expect(cloneAsJson({ a: 1, b: undefined })).toStrictEqual({ a: 1 });
	});

	it("renders a Date as its ISO string", () => {
		const clone = cloneAsJson({ at: new Date("2026-06-25T09:00:00.000Z") });
		expect(clone).toStrictEqual({ at: "2026-06-25T09:00:00.000Z" });
	});

	it("rejects values that cannot be represented in JSON", () => {
		for (const value of [
			{ revision: 1n },
			{ value: Number.NaN },
			[Number.POSITIVE_INFINITY],
			{ value: new Number(1) },
		])
			expect(() => cloneAsJson(value)).toThrow(
				"value cannot be represented as JSON",
			);
		expect(cloneAsJson({ revision: "18446744073709551615" })).toEqual({
			revision: "18446744073709551615",
		});
	});
});

describe("parseJsonObject", () => {
	it("parses an object", () => {
		expect(parseJsonObject('{"a":1}')).toStrictEqual({ a: 1 });
	});

	it("yields an empty object for malformed text", () => {
		expect(parseJsonObject("{ broken")).toStrictEqual({});
	});

	it("yields an empty object for the empty string", () => {
		expect(parseJsonObject("")).toStrictEqual({});
	});

	it("yields an empty object for valid JSON that is not an object", () => {
		expect(
			["[]", '"a"', "1", "null"].map((t) => parseJsonObject(t)),
		).toStrictEqual([{}, {}, {}, {}]);
	});
});

describe("asJsonObject", () => {
	it("turns a class instance into a plain document", () => {
		class Descriptor {
			readonly id = "a";
			render() {
				return this.id;
			}
		}
		expect(asJsonObject(new Descriptor())).toStrictEqual({ id: "a" });
	});

	it("yields an empty object for a value that is not one", () => {
		expect(
			[[1], "a", 1, null, undefined].map((v) => asJsonObject(v)),
		).toStrictEqual([{}, {}, {}, {}, {}]);
	});
});

describe("parseJsonValue", () => {
	it("parses each JSON shape", () => {
		expect(parseJsonValue('{"a":1}')).toStrictEqual({ a: 1 });
		expect(parseJsonValue("[1]")).toStrictEqual([1]);
		expect(parseJsonValue('"a"')).toBe("a");
		expect(parseJsonValue("1")).toBe(1);
		expect(parseJsonValue("true")).toBe(true);
	});

	it("yields null for malformed text", () => {
		expect(parseJsonValue("{ broken")).toBeNull();
	});

	it("cannot distinguish a parse failure from a parsed null", () => {
		expect(parseJsonValue("null")).toBeNull();
		expect(parseJsonValue("not json")).toBeNull();
	});
});

it("rejects JSON numbers outside the finite range", () => {
	expect(parseJsonValue("1e400")).toBeNull();
	expect(parseJsonValue('[1,{"value":-1e400}]')).toBeNull();
	expect(parseJsonObject('{"value":1e400}')).toEqual({});
});
