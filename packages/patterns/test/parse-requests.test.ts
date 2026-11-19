import { describe, expect, it } from "vitest";
import {
	PatternKind,
	PatternMaturity,
	RenderingKind,
} from "../src/_generated/patterns_pb.js";

import {
	canonicalJson,
	PatternParseError,
	parseApplicationRequest,
	parseCompositionRequest,
	parsePatternQuery,
	parseRenderRequest,
} from "../src/parse.js";

function messageOf(thunk: () => void): string {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(PatternParseError);
		return (error as Error).message;
	}
	return expect.unreachable("expected a PatternParseError") as never;
}

describe("parsePatternQuery", () => {
	it("accepts a string query", () => {
		const query = parsePatternQuery("event store");
		expect(query.query).toBe("event store");
		expect(query.maxResults).toBe(8);
	});

	it("refuses values that are neither strings nor objects", () => {
		for (const value of [null, undefined, 7, true, []]) {
			expect(messageOf(() => parsePatternQuery(value))).toBe(
				"query must be a string or object",
			);
		}
	});

	it("defaults maxResults and accepts a positive result limit", () => {
		expect(parsePatternQuery({}).maxResults).toBe(8);
		expect(parsePatternQuery({ maxResults: 4 }).maxResults).toBe(4);
	});

	it("rejects invalid result limits", () => {
		for (const value of [0, -1, 2.5, "abc", Number.NaN, null, {}, true]) {
			expect(() => parsePatternQuery({ maxResults: value })).toThrow(
				PatternParseError,
			);
		}
	});

	it("parses the current search request fields", () => {
		const query = parsePatternQuery({
			query: "event store",
			exactId: "bindle.named",
			maxResults: 4,
			languageFilter: "ts",
			contextFilter: "new-file",
			kindFilter: ["PATTERN_KIND_STARTER"],
			maturityFilter: ["PATTERN_MATURITY_STABLE"],
			renderingFilter: "RENDERING_KIND_PROJECT",
			allowDense: true,
			autoSelect: true,
			allowComposition: true,
		});
		expect(query).toMatchObject({
			query: "event store",
			exactId: "bindle.named",
			maxResults: 4,
			languageFilter: "ts",
			contextFilter: "new-file",
			kindFilter: [PatternKind.STARTER],
			maturityFilter: [PatternMaturity.STABLE],
			renderingFilter: RenderingKind.PROJECT,
			allowDense: true,
			autoSelect: true,
			allowComposition: true,
		});
	});

	it("rejects invalid filters and flag types", () => {
		expect(() => parsePatternQuery({ kindFilter: ["unknown"] })).toThrow(
			PatternParseError,
		);
		expect(() => parsePatternQuery({ maturityFilter: ["unknown"] })).toThrow(
			PatternParseError,
		);
		expect(() => parsePatternQuery({ autoSelect: "true" })).toThrow(
			PatternParseError,
		);
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

	it("refuses a missing, empty or whitespace-only pattern id", () => {
		for (const bad of [undefined, "", "   ", 7, null]) {
			expect(messageOf(() => parseRenderRequest({ patternId: bad }))).toBe(
				"patternId must be a non-empty string",
			);
		}
	});

	it("treats an absent or non-string rendering id as unspecified", () => {
		expect(parseRenderRequest({ patternId: "a.b" }).renderingId).toBe("");
		expect(
			parseRenderRequest({ patternId: "a.b", renderingId: 7 }).renderingId,
		).toBe("");
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

	it("refuses a non-object request", () => {
		expect(messageOf(() => parseApplicationRequest(undefined))).toBe(
			"application request must be an object",
		);
	});
});

describe("request params", () => {
	it("defaults to an empty record when omitted", () => {
		expect(parseRenderRequest({ patternId: "a.b" }).params).toEqual({});
	});

	it("stringifies scalar values", () => {
		expect(
			parseRenderRequest({ patternId: "a.b", params: { n: 7, b: true } })
				.params,
		).toEqual({ n: "7", b: "true" });
	});

	it("refuses a non-scalar param, naming the key", () => {
		for (const value of [{}, [], null, undefined, () => 1]) {
			expect(
				messageOf(() =>
					parseRenderRequest({ patternId: "a.b", params: { k: value } }),
				),
			).toBe("param k must be a scalar");
		}
	});

	it("refuses a params field that is not an object", () => {
		for (const bad of ["a=b", 7, []]) {
			expect(
				messageOf(() => parseRenderRequest({ patternId: "a.b", params: bad })),
			).toBe("params must be an object");
		}
	});

	it("accepts an empty params object", () => {
		expect(parseRenderRequest({ patternId: "a.b", params: {} }).params).toEqual(
			{},
		);
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
