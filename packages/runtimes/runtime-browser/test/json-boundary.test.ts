import { expect, it } from "vitest";
import {
	cloneAsJson,
	isJsonBigInt,
	isJsonNumber,
	isJsonString,
	parseJsonObject,
	parseJsonValue,
} from "../src/json.js";

it("rejects boxed values and numbers that JSON cannot represent", () => {
	expect(isJsonString(new String("a"))).toBe(false);
	expect(isJsonBigInt(Object(1n))).toBe(false);
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, new Number(1)]) {
		expect(isJsonNumber(value)).toBe(false);
		expect(() => cloneAsJson({ value })).toThrow(
			"value cannot be represented as JSON",
		);
	}
	expect(() => cloneAsJson({ value: 1n })).toThrow(
		"value cannot be represented as JSON",
	);
	expect(cloneAsJson({ value: "18446744073709551615" })).toEqual({
		value: "18446744073709551615",
	});
});

it("rejects JSON numbers outside the finite range", () => {
	expect(parseJsonValue("1e400")).toBeNull();
	expect(parseJsonValue('[1,{"value":-1e400}]')).toBeNull();
	expect(parseJsonObject('{"value":1e400}')).toEqual({});
});
