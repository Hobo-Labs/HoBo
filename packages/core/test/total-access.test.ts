/**
 * Total accessors — `must`, `at`, `first`, `last`, `mustGet`.
 *
 * These exist to replace `list[0]!` and `map.get(k)!`. The whole value of that
 * trade is *where* the failure lands: the non-null assertion hands the caller
 * an `undefined` that surfaces three frames later as a confusing
 * `cannot read property of undefined`, whereas these throw at the read site
 * naming what was missing. So the tests here are as much about the message as
 * about the narrowing — a regression that kept the throw but dropped the name
 * would silently give back the assertion's debugging experience.
 */
import { describe, expect, it } from "vitest";

import { at, first, last, must, mustGet } from "../src/total-access.js";

describe("must", () => {
	it("returns the value unchanged when present", () => {
		const value = { a: 1 };
		// Identity, not a copy: callers rely on `must(x)` being usable in place
		// of `x`, including for reference equality.
		expect(must(value)).toBe(value);
	});

	it("passes through falsy-but-present values", () => {
		// The guard is `undefined`/`null`, not truthiness. An implementation that
		// wrote `if (!value)` would reject a legitimate `0`, `""` or `false` —
		// exactly the values a caller most needs help distinguishing from absent.
		expect(must(0)).toBe(0);
		expect(must("")).toBe("");
		expect(must(false)).toBe(false);
		expect(must(Number.NaN)).toBeNaN();
	});

	it("throws for undefined and for null", () => {
		expect(() => must(undefined)).toThrow(/missing required value/u);
		// `null` is checked separately: a `value === undefined` test alone would
		// let a JSON-sourced null straight through into code typed as non-null.
		expect(() => must(null)).toThrow(/missing required value/u);
	});

	it("names what was missing when told", () => {
		expect(() => must(undefined, "route53 hosted zone id")).toThrow(
			"missing required value: route53 hosted zone id",
		);
	});

	it("omits the colon entirely when not told", () => {
		// Not "missing required value: undefined" — an unnamed throw must read as
		// unnamed rather than as a name that happens to be the word undefined.
		try {
			must(undefined);
			expect.unreachable("must(undefined) has to throw");
		} catch (error) {
			// SAFETY: must(undefined) above establishes the caught error as Error.
			expect((error as Error).message).toBe("missing required value");
		}
	});

	it("treats an empty name as no name", () => {
		// `what ? ... : ...` is truthiness on the *name*, which is right here:
		// an empty label adds nothing and would render as a trailing colon.
		try {
			must(undefined, "");
			expect.unreachable("must(undefined) has to throw");
		} catch (error) {
			// SAFETY: must(undefined, "") above establishes the caught error as Error.
			expect((error as Error).message).toBe("missing required value");
		}
	});
});

describe("at", () => {
	it("reads a positive index", () => {
		expect(at([10, 20, 30], 1)).toBe(20);
	});

	it("reads a negative index from the end", () => {
		// `Array.prototype.at` semantics, deliberately: the accessor is a thin
		// total wrapper and must not re-implement indexing.
		expect(at([10, 20, 30], -1)).toBe(30);
	});

	it("throws naming the collection, the index and the length", () => {
		// All three, because "index out of range" without the length is the
		// hardest version of this bug to diagnose from a log line.
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
		// `Indexed<T>` is deliberately structural rather than `readonly T[]`,
		// which would have excluded strings, TypedArrays and Buffers. This is the
		// test that would fail if someone "simplified" the type back to an array.
		expect(at("abc", 1)).toBe("b");
		expect(() => at("abc", 9)).toThrow(/length 3/u);
	});

	it("works on typed arrays", () => {
		expect(at(Uint8Array.from([7, 8]), 0)).toBe(7);
		expect(() => at(Uint8Array.from([7, 8]), 2)).toThrow(/length 2/u);
	});

	it("throws for a hole and for a stored undefined alike", () => {
		// A stored `undefined` is indistinguishable from absent through `at`,
		// and that is the documented cost of the total accessor. Pinned so the
		// limitation is a decision rather than a surprise.
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
		// `last` delegates to `at(items, -1)`, so its message says `[-1]`. That is
		// the honest thing to report: it tells a reader which accessor threw.
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
		// `String(key)` rather than template concatenation, so a symbol key
		// reports rather than throwing a TypeError from inside the error path —
		// an error constructor that itself throws hides the original failure.
		const symbol = Symbol("tenant");
		expect(() => mustGet(new Map<symbol, number>(), symbol)).toThrow(
			"missing required value: map[Symbol(tenant)]",
		);
		expect(() => mustGet(new Map<number, string>(), 7)).toThrow(
			"missing required value: map[7]",
		);
	});

	it("throws for a key whose stored value is undefined", () => {
		// Same documented limitation as `at`: `Map.get` cannot distinguish a
		// stored `undefined` from a missing key, so neither can this.
		const map = new Map<string, number | undefined>([["k", undefined]]);
		expect(map.has("k")).toBe(true);
		expect(() => mustGet(map, "k")).toThrow(/map\[k\]/u);
	});
});
