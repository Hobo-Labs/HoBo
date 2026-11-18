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
		const query = parsePatternQuery("event store");
		expect(query.query).toBe("event store");
		expect(query.maxResults).toBe(8);
	});

	it("refuses a non-object, non-string input", () => {
		for (const bad of [null, undefined, 7, true, []]) {
			if (Array.isArray(bad)) continue;
			expect(messageOf(() => parsePatternQuery(bad))).toBe(
				"query must be a string or object",
			);
		}
	});

	it("treats an array as an empty query object rather than refusing it", () => {
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
		expect(parsePatternQuery({ topK: "5" }).maxResults).toBe(5);
	});

	it("falls back to 8 for a topK that is not a usable positive number", () => {
		for (const bad of [0, -1, "abc", Number.NaN, null, {}, true]) {
			expect(parsePatternQuery({ topK: bad }).maxResults).toBe(8);
		}
	});

	it("keeps a fractional topK as given", () => {
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
		for (const bad of [undefined, "", "   ", 7, null]) {
			expect(messageOf(() => parseRenderRequest({ patternId: bad }))).toBe(
				"patternId must be a non-empty string",
			);
		}
	});

	it("treats an absent or non-string rendering id as unspecified", () => {
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
		expect(
			parseRenderRequest({ id: "a.b", params: { n: 7, b: true } }).params,
		).toEqual({ n: "7", b: "true" });
	});

	it("refuses a non-scalar param, naming the key", () => {
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
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}\n',
		);
	});

	it("preserves array order", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]\n");
	});

	it("sorts keys inside array elements", () => {
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]\n');
	});

	it("ends with a newline", () => {
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
