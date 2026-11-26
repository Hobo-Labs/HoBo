/**
 * The JSON document boundary: what counts as JSON, and what crossing it costs.
 *
 * Every runtime package carries its own copy of these guards, because a
 * runtime must not depend on a sibling runtime to decide what a JSON value is.
 * They sit at the edge where untyped documents — kubectl output, a manifest, a
 * recorded payload — become typed domain values, and every one of them is
 * total: nothing here throws on a hostile input, because the callers are parse
 * sites with no useful fallback of their own.
 *
 * Three properties carry the weight:
 *
 * **A parse failure yields the empty value, not an exception.** `kubectl` can
 * emit a warning line before its JSON, a partially-written file can be
 * truncated. A throw at those sites turns a recoverable "nothing to read" into
 * a crashed reconcile loop, so `parseJsonObject` returns `{}` and
 * `parseJsonValue` returns `null`.
 *
 * **Structural checks, not `typeof`.** `isJsonObject` refuses `null` and
 * arrays explicitly — both of which `typeof` calls `"object"` — because the
 * callers go on to read named fields, and both would silently read
 * `undefined` instead.
 *
 * **Cloning goes through JSON.** `cloneAsJson` round-trips through
 * `JSON.stringify`, so what comes back is a value with no prototype, no
 * methods, and no shared references with its source. That is the point: a
 * domain object handed across this boundary cannot smuggle behaviour, and a
 * later mutation of the original cannot reach the clone.
 *
 * The tag-based checks have edges worth naming rather than discovering later,
 * and they are pinned below.
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

describe("isJsonString", () => {
	it("accepts a string", () => {
		expect(isJsonString("a")).toBe(true);
	});

	it("accepts the empty string", () => {
		// Empty is a value, not an absence. A truthiness check here would make
		// a recorded empty field indistinguishable from a missing one.
		expect(isJsonString("")).toBe(true);
	});

	it("refuses a number, a boolean, null and undefined", () => {
		expect(
			[1, true, null, undefined].map((v) => isJsonString(v)),
		).toStrictEqual([false, false, false, false]);
	});

	it("refuses an object with a toString", () => {
		// Structural, not coercible: a value that merely renders as a string is
		// not a string, and treating it as one would put an object into a field
		// the schema declares as text.
		expect(isJsonString({ toString: () => "a" })).toBe(false);
	});

	it("accepts a boxed String, because the check is tag-based", () => {
		// QUIRK: `new String("a")` carries the `[object String]` tag, so it
		// passes — and then behaves as an object at the call site
		// (`JSON.stringify` renders it as a string, but `typeof` says object).
		// Nothing in these runtimes constructs boxed primitives, so this is
		// pinned as documented behaviour rather than treated as a defect.
		expect(isJsonString(new String("a"))).toBe(true);
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
		// A field arriving as `"1"` is a string field. Accepting it here would
		// let a schema mismatch through silently.
		expect(isJsonNumber("1")).toBe(false);
	});

	it("refuses a bigint", () => {
		expect(isJsonNumber(1n)).toBe(false);
	});

	it("accepts NaN and Infinity, which JSON cannot represent", () => {
		// GAP: both carry the `[object Number]` tag, so they pass a check whose
		// name promises a *JSON* number — and `JSON.stringify` turns both into
		// `null`. A value that passes the guard and then serialises to null is
		// the failure mode this guard exists to prevent. Pinned, not fixed:
		// tightening it is a behaviour change across three runtime packages and
		// belongs in its own change.
		expect(isJsonNumber(Number.NaN)).toBe(true);
		expect(isJsonNumber(Number.POSITIVE_INFINITY)).toBe(true);
		expect(JSON.stringify(Number.NaN)).toBe("null");
	});
});

describe("isJsonBigInt", () => {
	it("accepts a bigint", () => {
		expect(isJsonBigInt(1n)).toBe(true);
	});

	it("refuses a number", () => {
		// The distinction is the point: these runtimes carry 64-bit revisions
		// and offsets that lose precision as doubles.
		expect(isJsonBigInt(1)).toBe(false);
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
		// `0`, `""` and `null` are the values a loose check would misclassify,
		// and each means something different from `false` in a manifest.
		expect(
			[0, 1, "", "true", null, undefined].map((v) => isJsonBoolean(v)),
		).toStrictEqual([false, false, false, false, false, false]);
	});

	it("refuses a boxed Boolean, unlike isJsonString", () => {
		// QUIRK: this guard compares by identity rather than by tag, so the
		// boxed form is refused here and accepted by `isJsonString`. The two
		// are inconsistent with each other; the stricter behaviour is the one
		// worth keeping, so this is pinned as the intended asymmetry.
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
		// `typeof null === "object"`. Callers read named fields off whatever
		// passes, and null would throw at the first read rather than here.
		expect(isJsonObject(null)).toBe(false);
	});

	it("refuses undefined", () => {
		expect(isJsonObject(undefined)).toBe(false);
	});

	it("refuses an array", () => {
		// Arrays are objects to `typeof` too, and their numeric indices would
		// become field names at the call site.
		expect([isJsonObject([]), isJsonObject([1, 2])]).toStrictEqual([
			false,
			false,
		]);
	});

	it("refuses a Date, a Map and a RegExp", () => {
		// Each has its own tag, and each loses everything meaningful when
		// serialised as a JSON object — a Map becomes `{}`.
		expect(
			[new Date(), new Map(), /x/].map((v) => isJsonObject(v)),
		).toStrictEqual([false, false, false]);
	});

	it("accepts a null-prototype object", () => {
		// The safest shape a parsed document can take, and one a prototype
		// check would wrongly reject.
		expect(isJsonObject(Object.create(null))).toBe(true);
	});

	it("accepts a class instance", () => {
		// Tag-based, so an instance passes and its methods are then dropped by
		// `cloneAsJson`. That is the intended flow: `asJsonObject` is how a
		// domain object becomes a document.
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
		// A string is indexable and has a length; treating it as an array would
		// iterate it character by character.
		expect([{}, "ab", null].map((v) => isJsonArray(v))).toStrictEqual([
			false,
			false,
			false,
		]);
	});
});

describe("cloneAsJson", () => {
	it("turns undefined into null", () => {
		// A JSON document has no `undefined`. Null is the representable absence.
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
		// The whole point of cloning at this boundary: a later mutation of the
		// caller's object must not reach a document already handed on.
		const source = { nested: { list: [1] } };
		const clone = cloneAsJson(source);
		source.nested.list.push(2);
		expect(clone).toStrictEqual({ nested: { list: [1] } });
	});

	it("drops methods and the prototype", () => {
		// A cloned value cannot smuggle behaviour across the boundary.
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
		// `JSON.stringify` omits them, so an absent field stays absent — a
		// caller distinguishing "unset" from "explicitly null" keeps that.
		expect(cloneAsJson({ a: 1, b: undefined })).toStrictEqual({ a: 1 });
	});

	it("renders a Date as its ISO string", () => {
		const clone = cloneAsJson({ at: new Date("2026-06-25T09:00:00.000Z") });
		expect(clone).toStrictEqual({ at: "2026-06-25T09:00:00.000Z" });
	});

	it("throws on a bigint, despite isJsonBigInt living beside it", () => {
		// GAP: this module recognises bigints and cannot clone them —
		// `JSON.stringify` throws rather than returning undefined, so this is
		// the one guard in the file that is not total. A revision or offset
		// carried as a bigint therefore cannot cross this boundary at all.
		// Pinned rather than fixed: choosing a representation (string? number?
		// refuse?) is a wire-format decision, not a test fix.
		expect(() => cloneAsJson({ revision: 1n })).toThrow(/BigInt/);
	});
});

describe("parseJsonObject", () => {
	it("parses an object", () => {
		expect(parseJsonObject('{"a":1}')).toStrictEqual({ a: 1 });
	});

	it("yields an empty object for malformed text", () => {
		// A truncated file or a tool that printed a warning first. Throwing
		// here would turn "nothing readable" into a crashed reconcile loop.
		expect(parseJsonObject("{ broken")).toStrictEqual({});
	});

	it("yields an empty object for the empty string", () => {
		expect(parseJsonObject("")).toStrictEqual({});
	});

	it("yields an empty object for valid JSON that is not an object", () => {
		// `[]`, `"a"`, `1` and `null` all parse. None of them has the named
		// fields the caller is about to read.
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
		// Same contract as `parseJsonObject`: the caller reads named fields,
		// and an array or a scalar has none.
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
		// Both are `null`. Callers that need the difference must check the text
		// themselves — pinned here so nobody assumes a null return means the
		// document was bad.
		expect(parseJsonValue("null")).toBeNull();
		expect(parseJsonValue("not json")).toBeNull();
	});
});
