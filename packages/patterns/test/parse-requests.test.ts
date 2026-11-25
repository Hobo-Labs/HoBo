/**
 * The request parse boundary: search queries, render/composition/application
 * requests, and canonical JSON.
 *
 * These are the front door. A pattern id, a rendering id, an isolation root and
 * a target path all arrive here from a CLI, an MCP call, or a JSON body, and
 * every one of them is used afterwards as a lookup key or a path segment. So
 * the assertions below are mostly about *refusal*: an empty pattern id would
 * match nothing and be reported as "no such pattern" rather than as a malformed
 * request, and an empty isolation root would let an apply run write relative to
 * wherever the process happened to be.
 *
 * The search query is the opposite shape — it is deliberately forgiving,
 * because a query is user text and a slightly odd one should return results
 * rather than an error. What must *not* be forgiving is the numeric bound:
 * `topK` reaching the retrieval layer as `NaN` or `0` would silently return
 * nothing, which reads to a caller exactly like "no pattern matches".
 */
import { describe, expect, it } from "vitest";

import {
	canonicalJson,
	PatternParseError,
	parseApplicationRequest,
	parseCompositionRequest,
	parsePatternQuery,
	parseRenderRequest,
} from "../src/parse.js";

function messageOf(thunk: () => unknown): string {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(PatternParseError);
		return (error as Error).message;
	}
	return expect.unreachable("expected a PatternParseError") as never;
}

describe("parsePatternQuery", () => {
	it("accepts a bare string as the query", () => {
		// The common case from a CLI. Requiring an object wrapper would make
		// every caller build one for a single field.
		const query = parsePatternQuery("event store");
		expect(query.query).toBe("event store");
		expect(query.maxResults).toBe(8);
	});

	it("refuses a non-object, non-string input", () => {
		for (const bad of [null, undefined, 7, true, []]) {
			// An array is an object to `typeof`, so it reaches the record branch
			// and parses to an empty query rather than being refused — pinned
			// below rather than asserted here.
			if (Array.isArray(bad)) continue;
			expect(messageOf(() => parsePatternQuery(bad))).toBe(
				"query must be a string or object",
			);
		}
	});

	it("treats an array as an empty query object rather than refusing it", () => {
		// Pinning a wart. `typeof [] === "object"` and it is not null, so an
		// array slips past the guard and every field reads as absent. The result
		// is an empty query that matches nothing, not a crash — so the cost is a
		// confusing "no results" rather than an error naming the real problem.
		// Recorded rather than changed: tightening it is a one-line
		// `Array.isArray` check, but it changes what a malformed caller gets
		// back, which is a decision for whoever owns the request contract.
		const query = parsePatternQuery([]);
		expect(query.query).toBe("");
		expect(query.maxResults).toBe(8);
	});

	it("defaults maxResults to 8 and accepts either spelling", () => {
		expect(parsePatternQuery({ topK: 3 }).maxResults).toBe(3);
		expect(parsePatternQuery({ maxResults: 4 }).maxResults).toBe(4);
		expect(parsePatternQuery({}).maxResults).toBe(8);
	});

	it("prefers topK when both spellings are present", () => {
		expect(parsePatternQuery({ topK: 3, maxResults: 9 }).maxResults).toBe(3);
	});

	it("accepts a numeric string for topK", () => {
		// CLI arguments arrive as strings. Coercing here is what keeps the
		// retrieval layer free to assume a number.
		expect(parsePatternQuery({ topK: "5" }).maxResults).toBe(5);
	});

	it("falls back to 8 for a topK that is not a usable positive number", () => {
		// The consequential branch. `topK: 0` or `NaN` reaching retrieval would
		// return an empty candidate list, and a caller cannot tell that from
		// "nothing matched your query".
		for (const bad of [0, -1, "abc", Number.NaN, null, {}, true]) {
			expect(parsePatternQuery({ topK: bad }).maxResults).toBe(8);
		}
	});

	it("keeps a fractional topK as given", () => {
		// `Number.isFinite && > 0` does not require an integer, so 2.5 survives.
		// Pinned because it is the kind of thing a reader would assume away, and
		// because the retrieval layer slices with it.
		expect(parsePatternQuery({ topK: 2.5 }).maxResults).toBe(2.5);
	});

	it("accepts either spelling of the exact id", () => {
		expect(parsePatternQuery({ id: "a.b" }).exactId).toBe("a.b");
		expect(parsePatternQuery({ exactId: "a.b" }).exactId).toBe("a.b");
		expect(parsePatternQuery({ id: "first", exactId: "second" }).exactId).toBe(
			"first",
		);
	});

	it("requires the boolean flags to be exactly true", () => {
		// `=== true`, so a truthy string from a query parameter does not silently
		// enable dense retrieval or auto-selection. Auto-select in particular
		// decides whether a pattern is applied without a human choosing it.
		for (const value of ["true", 1, {}, []]) {
			const query = parsePatternQuery({
				allowDense: value,
				autoSelect: value,
				compose: value,
			});
			expect(query.allowDense).toBe(false);
			expect(query.autoSelect).toBe(false);
			expect(query.allowComposition).toBe(false);
		}
		const enabled = parsePatternQuery({
			allowDense: true,
			autoSelect: true,
			compose: true,
		});
		expect(enabled.allowDense).toBe(true);
		expect(enabled.autoSelect).toBe(true);
		expect(enabled.allowComposition).toBe(true);
	});

	it("treats a non-string language or context filter as absent", () => {
		// `optStr` returns "" for anything that is not a string, and an empty
		// filter means "do not filter" downstream. Forgiving on purpose: a
		// filter is a narrowing convenience, not a correctness boundary.
		expect(parsePatternQuery({ language: 7 }).languageFilter).toBe("");
		expect(parsePatternQuery({ context: null }).contextFilter).toBe("");
		expect(parsePatternQuery({ language: "ts" }).languageFilter).toBe("ts");
	});

	it("accepts kind and maturity filters in either spelling", () => {
		expect(parsePatternQuery({ kind: "starter" }).kindFilter).toHaveLength(1);
		expect(parsePatternQuery({ kinds: "starter" }).kindFilter).toHaveLength(1);
		expect(
			parsePatternQuery({ maturity: "stable" }).maturityFilter,
		).toHaveLength(1);
	});

	it("splits a comma-separated filter list", () => {
		expect(
			parsePatternQuery({ kind: "starter,guidance" }).kindFilter,
		).toHaveLength(2);
	});

	it("refuses an unrecognised kind or maturity, naming the value", () => {
		// Unlike the free-text filters, these are enums. Silently ignoring an
		// unknown one would widen the search rather than narrowing it, and the
		// caller would get more results than they asked to see.
		expect(messageOf(() => parsePatternQuery({ kind: "nope" }))).toContain(
			'kind has unknown value "nope"',
		);
		expect(messageOf(() => parsePatternQuery({ maturity: "nope" }))).toContain(
			"maturity has unknown value",
		);
	});

	it("treats an empty filter string as no filter", () => {
		expect(parsePatternQuery({ kind: "" }).kindFilter).toEqual([]);
		expect(parsePatternQuery({}).kindFilter).toEqual([]);
	});
});

describe("parseRenderRequest", () => {
	it("parses a well-formed request and freezes it", () => {
		const request = parseRenderRequest({
			patternId: "a.b",
			renderingId: "r1",
			params: { name: "x" },
		});
		expect(request.patternId).toBe("a.b");
		expect(request.renderingId).toBe("r1");
		expect(request.params).toEqual({ name: "x" });
		expect(Object.isFrozen(request)).toBe(true);
	});

	it("accepts id as an alias for patternId", () => {
		expect(parseRenderRequest({ id: "a.b" }).patternId).toBe("a.b");
		expect(
			parseRenderRequest({ patternId: "first", id: "second" }).patternId,
		).toBe("first");
	});

	it("refuses a missing, empty or whitespace-only pattern id", () => {
		// An empty id matches nothing and would be reported downstream as "no
		// such pattern", sending the caller to look for a pattern that exists
		// rather than at their own request.
		for (const bad of [undefined, "", "   ", 7, null]) {
			expect(messageOf(() => parseRenderRequest({ patternId: bad }))).toBe(
				"patternId must be a non-empty string",
			);
		}
	});

	it("treats an absent or non-string rendering id as unspecified", () => {
		// Optional on purpose: omitting it selects the pattern's default
		// rendering, which is the common case.
		expect(parseRenderRequest({ id: "a.b" }).renderingId).toBe("");
		expect(parseRenderRequest({ id: "a.b", renderingId: 7 }).renderingId).toBe(
			"",
		);
	});

	it("refuses a non-object request", () => {
		for (const bad of [null, undefined, "a.b", 7]) {
			expect(messageOf(() => parseRenderRequest(bad))).toBe(
				"render request must be an object",
			);
		}
	});
});

describe("parseCompositionRequest", () => {
	it("parses a query and params", () => {
		const request = parseCompositionRequest({
			query: "event store",
			params: { a: "1" },
		});
		expect(request.query).toBe("event store");
		expect(request.params).toEqual({ a: "1" });
		expect(Object.isFrozen(request)).toBe(true);
	});

	it("requires a non-empty query", () => {
		// Composition over an empty query would select whatever the retrieval
		// layer's floor happens to admit, which is an arbitrary set of patterns
		// applied to somebody's project.
		for (const bad of [undefined, "", "  ", 7]) {
			expect(messageOf(() => parseCompositionRequest({ query: bad }))).toBe(
				"query must be a non-empty string",
			);
		}
	});

	it("refuses a non-object request", () => {
		expect(messageOf(() => parseCompositionRequest(null))).toBe(
			"composition request must be an object",
		);
	});
});

describe("parseApplicationRequest", () => {
	const REQUEST = {
		patternId: "a.b",
		isolationRoot: "/tmp/iso",
		targetPath: "src/x.ts",
		isolationRunId: "run-1",
		params: { name: "x" },
	};

	it("parses a well-formed request and freezes it", () => {
		const request = parseApplicationRequest(REQUEST);
		expect(request.patternId).toBe("a.b");
		expect(request.isolationRoot).toBe("/tmp/iso");
		expect(request.targetPath).toBe("src/x.ts");
		expect(request.isolationRunId).toBe("run-1");
		expect(Object.isFrozen(request)).toBe(true);
	});

	it("requires every identifier and path", () => {
		// All four are load-bearing. `isolationRoot` in particular is the
		// sandbox an apply writes inside: an empty one would resolve relative to
		// the process's working directory, so a pattern application would write
		// into whatever tree the caller happened to be standing in.
		for (const field of [
			"patternId",
			"isolationRoot",
			"targetPath",
			"isolationRunId",
		] as const) {
			const message = messageOf(() =>
				parseApplicationRequest({ ...REQUEST, [field]: "" }),
			);
			expect(message).toBe(`${field} must be a non-empty string`);
		}
	});

	it("accepts id as an alias for patternId here too", () => {
		const { patternId, ...rest } = REQUEST;
		expect(parseApplicationRequest({ ...rest, id: patternId }).patternId).toBe(
			"a.b",
		);
	});

	it("refuses a non-object request", () => {
		expect(messageOf(() => parseApplicationRequest(undefined))).toBe(
			"application request must be an object",
		);
	});
});

describe("request params", () => {
	it("defaults to an empty record when omitted", () => {
		expect(parseRenderRequest({ id: "a.b" }).params).toEqual({});
	});

	it("stringifies scalar values", () => {
		// Numbers and booleans arrive from JSON bodies routinely; coercing here
		// keeps every substitution downstream a string.
		expect(
			parseRenderRequest({ id: "a.b", params: { n: 7, b: true } }).params,
		).toEqual({ n: "7", b: "true" });
	});

	it("refuses a non-scalar param, naming the key", () => {
		// An object or array parameter would stringify to `[object Object]` or a
		// comma-joined list and be substituted into generated source as that
		// text. Refusing names the key so the author knows which one to fix.
		for (const value of [{}, [], null, undefined, () => 1]) {
			expect(
				messageOf(() =>
					parseRenderRequest({ id: "a.b", params: { k: value } }),
				),
			).toBe("param k must be a scalar");
		}
	});

	it("refuses a params field that is not an object", () => {
		for (const bad of ["a=b", 7, []]) {
			expect(
				messageOf(() => parseRenderRequest({ id: "a.b", params: bad })),
			).toBe("params must be an object");
		}
	});

	it("accepts an empty params object", () => {
		expect(parseRenderRequest({ id: "a.b", params: {} }).params).toEqual({});
	});
});

describe("canonicalJson", () => {
	it("sorts object keys at every depth", () => {
		// The property receipts and digests depend on: two records that differ
		// only in key order must serialize identically, or a replay comparison
		// would report a difference where none exists.
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}\n',
		);
	});

	it("preserves array order", () => {
		// Arrays are ordered data. Sorting them would make a rendering list hash
		// the same as its reverse.
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]\n");
	});

	it("sorts keys inside array elements", () => {
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]\n');
	});

	it("ends with a newline", () => {
		// So the output is a well-formed line in a file and does not show as a
		// no-newline-at-end-of-file diff on every write.
		expect(canonicalJson({}).endsWith("\n")).toBe(true);
	});

	it("passes primitives and null through", () => {
		expect(canonicalJson(null)).toBe("null\n");
		expect(canonicalJson(7)).toBe("7\n");
		expect(canonicalJson("x")).toBe('"x"\n');
		expect(canonicalJson(true)).toBe("true\n");
	});

	it("produces identical output for key-permuted inputs", () => {
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});
});
