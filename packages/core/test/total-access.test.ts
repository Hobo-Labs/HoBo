import { describe, expect, it } from "vitest";

import { at, first, last, must, mustGet } from "../src/total-access.js";

describe("must", () => {
	it("returns the value unchanged when present", () => {
		const value = { a: 1 };
		expect(must(value)).toBe(value);
	});

	it("passes through falsy-but-present values", () => {
		expect(must(0)).toBe(0);
		expect(must("")).toBe("");
		expect(must(false)).toBe(false);
		expect(must(Number.NaN)).toBeNaN();
	});

	it("throws for undefined and for null", () => {
		expect(() => must(undefined)).toThrow(/missing required value/u);
		expect(() => must(null)).toThrow(/missing required value/u);
	});

	it("names what was missing when told", () => {
		expect(() => must(undefined, "route53 hosted zone id")).toThrow(
			"missing required value: route53 hosted zone id",
		);
	});

	it("omits the colon entirely when not told", () => {
		try {
			must(undefined);
			expect.unreachable("must(undefined) has to throw");
		} catch (error) {
			expect((error as Error).message).toBe("missing required value");
		}
	});

	it("treats an empty name as no name", () => {
		try {
			must(undefined, "");
			expect.unreachable("must(undefined) has to throw");
		} catch (error) {
			expect((error as Error).message).toBe("missing required value");
		}
	});
});

describe("at", () => {
	it("reads a positive index", () => {
		expect(at([10, 20, 30], 1)).toBe(20);
	});

	it("reads a negative index from the end", () => {
		expect(at([10, 20, 30], -1)).toBe(30);
	});

	it("throws naming the collection, the index and the length", () => {
		expect(() => at([10, 20], 5, "candidates")).toThrow(
			"missing required value: candidates[5] (length 2)",
		);
	});

	it("falls back to the word collection when unnamed", () => {
		expect(() => at([], 0)).toThrow(
			"missing required value: collection[0] (length 0)",
		);
	});

	it("works on strings", () => {
		expect(at("abc", 1)).toBe("b");
		expect(() => at("abc", 9)).toThrow(/length 3/u);
	});

	it("works on typed arrays", () => {
		expect(at(Uint8Array.from([7, 8]), 0)).toBe(7);
		expect(() => at(Uint8Array.from([7, 8]), 2)).toThrow(/length 2/u);
	});

	it("throws for a hole and for a stored undefined alike", () => {
		// biome-ignore lint/suspicious/noSparseArray: the sparse hole is the case under test.
		const withHole = [1, undefined, 3];
		delete withHole[1];
		expect(() => at(withHole, 1)).toThrow();
		expect(() => at([undefined], 0)).toThrow();
	});
});

describe("first / last", () => {
	it("read the ends of a populated collection", () => {
		expect(first([1, 2, 3])).toBe(1);
		expect(last([1, 2, 3])).toBe(3);
	});

	it("both throw on an empty collection, reporting their own index", () => {
		expect(() => first([], "zones")).toThrow("zones[0] (length 0)");
		expect(() => last([], "zones")).toThrow("zones[-1] (length 0)");
	});

	it("coincide for a single-element collection", () => {
		expect(first(["only"])).toBe("only");
		expect(last(["only"])).toBe("only");
	});
});

describe("mustGet", () => {
	it("returns a present value", () => {
		expect(mustGet(new Map([["k", 42]]), "k")).toBe(42);
	});

	it("throws naming the map and the key", () => {
		expect(() => mustGet(new Map<string, number>(), "k", "tier index")).toThrow(
			"missing required value: tier index[k]",
		);
	});

	it("falls back to the word map when unnamed", () => {
		expect(() => mustGet(new Map<string, number>(), "k")).toThrow(
			"missing required value: map[k]",
		);
	});

	it("stringifies a non-string key for the message", () => {
		const symbol = Symbol("tenant");
		expect(() => mustGet(new Map<symbol, number>(), symbol)).toThrow(
			"missing required value: map[Symbol(tenant)]",
		);
		expect(() => mustGet(new Map<number, string>(), 7)).toThrow(
			"missing required value: map[7]",
		);
	});

	it("throws for a key whose stored value is undefined", () => {
		const map = new Map<string, number | undefined>([["k", undefined]]);
		expect(map.has("k")).toBe(true);
		expect(() => mustGet(map, "k")).toThrow(/map\[k\]/u);
	});
});
