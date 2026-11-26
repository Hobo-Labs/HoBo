/**
 * Catalog and rendered-output validation.
 *
 * Both validators are pure and both are gates, so their branches are the rules
 * that decide whether a pattern ships. The rendered-output validator in
 * particular is the security boundary for generated code, and three of its
 * checks are load-bearing in a way that is easy to lose:
 *
 *   - `llmCalls must be 0` — patterns are supposed to be deterministic
 *     template output. A rendering that called a model is not reproducible, so
 *     the receipt asserting zero is the whole zero-inference claim.
 *   - path safety — an absolute path or a `..` segment in generated output
 *     writes outside the project.
 *   - provider pins and secrets — a pattern that hardcodes `aws-` or an
 *     `sk-…` key propagates it to every project that renders it.
 *
 * The catalog validator's job is different: it catches ambiguity *before*
 * retrieval, where a duplicate alias would otherwise resolve arbitrarily.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	PatternManifestSchema,
	PatternRenderReceiptSchema,
} from "../src/_generated/patterns_pb.js";
import type { PatternCatalog } from "../src/catalog.js";
import { PatternParseError } from "../src/parse.js";
import {
	parseEvalCases,
	validatePatternCatalog,
	validateRenderedPattern,
} from "../src/validate.js";

function pattern(overrides: Record<string, unknown> = {}) {
	return create(PatternManifestSchema, {
		id: "bindle.api",
		version: 1,
		provenance: [{ source: "hobo" }],
		renderings: [{ isDefault: true }],
		...overrides,
	});
}

function catalog(...patterns: ReturnType<typeof pattern>[]): PatternCatalog {
	return { root: "/patterns", digest: "sha256:cat", patterns };
}

function receipt(overrides: Record<string, unknown> = {}) {
	return create(PatternRenderReceiptSchema, {
		patternId: "bindle.api",
		llmCalls: 0,
		replayDigest: "sha256:out",
		files: [],
		...overrides,
	});
}

const file = (path: string, contents: string) => ({ path, contents });

describe("validatePatternCatalog", () => {
	it("accepts a well-formed catalog", () => {
		const report = validatePatternCatalog({ catalog: catalog(pattern()) });
		expect(report.ok).toBe(true);
		expect(report.issues).toEqual([]);
	});

	it("reports the pattern count and carries the digest through", () => {
		const report = validatePatternCatalog({
			catalog: catalog(pattern(), pattern({ id: "bindle.web" })),
		});
		expect(report.patternCount).toBe(2);
		expect(report.digest).toBe("sha256:cat");
	});

	it("accepts an empty catalog rather than treating it as broken", () => {
		expect(validatePatternCatalog({ catalog: catalog() }).ok).toBe(true);
	});

	it("rejects a duplicate id", () => {
		const report = validatePatternCatalog({
			catalog: catalog(pattern(), pattern()),
		});
		expect(report.ok).toBe(false);
		expect(report.issues).toContain("duplicate id bindle.api");
	});

	it("rejects a zero or negative version", () => {
		for (const version of [0, -1]) {
			const report = validatePatternCatalog({
				catalog: catalog(pattern({ version })),
			});
			expect(report.issues).toContain("bindle.api: version");
		}
	});

	it("rejects a pattern with no provenance", () => {
		// Provenance is how a pattern's origin stays checkable.
		const report = validatePatternCatalog({
			catalog: catalog(pattern({ provenance: [] })),
		});
		expect(report.issues).toContain("bindle.api: provenance");
	});

	it("requires exactly one default rendering, not zero", () => {
		const report = validatePatternCatalog({
			catalog: catalog(pattern({ renderings: [{ isDefault: false }] })),
		});
		expect(report.issues).toContain("bindle.api: default rendering");
	});

	it("requires exactly one default rendering, not two", () => {
		// Two defaults means the choice is arbitrary at render time.
		const report = validatePatternCatalog({
			catalog: catalog(
				pattern({ renderings: [{ isDefault: true }, { isDefault: true }] }),
			),
		});
		expect(report.issues).toContain("bindle.api: default rendering");
	});

	it("rejects an alias claimed by two patterns", () => {
		// The ambiguity that would otherwise resolve arbitrarily at retrieval.
		const report = validatePatternCatalog({
			catalog: catalog(
				pattern({ aliases: ["rest"] }),
				pattern({ id: "bindle.web", aliases: ["rest"] }),
			),
		});
		expect(report.ok).toBe(false);
		expect(report.issues.join()).toContain("alias rest claimed by");
	});

	it("treats aliases case- and whitespace-insensitively when detecting collisions", () => {
		const report = validatePatternCatalog({
			catalog: catalog(
				pattern({ aliases: ["REST"] }),
				pattern({ id: "bindle.web", aliases: ["  rest  "] }),
			),
		});
		expect(report.ok).toBe(false);
	});

	it("also collides legacy aliases against current ones", () => {
		const report = validatePatternCatalog({
			catalog: catalog(
				pattern({ aliases: ["rest"] }),
				pattern({ id: "bindle.web", legacyAliases: ["rest"] }),
			),
		});
		expect(report.ok).toBe(false);
	});

	it("allows one pattern to repeat its own alias", () => {
		// Same id claiming the same alias twice is redundant, not ambiguous.
		const report = validatePatternCatalog({
			catalog: catalog(pattern({ aliases: ["rest"], legacyAliases: ["rest"] })),
		});
		expect(report.ok).toBe(true);
	});

	it("ignores a blank alias rather than colliding on emptiness", () => {
		const report = validatePatternCatalog({
			catalog: catalog(
				pattern({ aliases: ["  "] }),
				pattern({ id: "bindle.web", aliases: [""] }),
			),
		});
		expect(report.ok).toBe(true);
	});

	it("rejects a pattern that both provides and conflicts with the same thing", () => {
		const report = validatePatternCatalog({
			catalog: catalog(pattern({ provides: ["http"], conflicts: ["http"] })),
		});
		expect(report.issues).toContain("bindle.api: provides and conflicts http");
	});

	it("allows conflicts that are not also provided", () => {
		const report = validatePatternCatalog({
			catalog: catalog(pattern({ provides: ["http"], conflicts: ["grpc"] })),
		});
		expect(report.ok).toBe(true);
	});

	it("collects every issue rather than stopping at the first", () => {
		const report = validatePatternCatalog({
			catalog: catalog(pattern({ version: 0, provenance: [], renderings: [] })),
		});
		expect(report.issues.length).toBeGreaterThanOrEqual(3);
	});
});

describe("validateRenderedPattern", () => {
	it("accepts a clean rendering", () => {
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt(),
		});
		expect(report.ok).toBe(true);
		expect(report.digest).toBe("sha256:out");
	});

	it("rejects a receipt for a different pattern", () => {
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt({ patternId: "bindle.web" }),
		});
		expect(report.issues).toContain("pattern id mismatch");
	});

	it("rejects any rendering that called a model", () => {
		// The zero-inference claim, asserted. A rendering that called an LLM is
		// not reproducible, so the whole determinism story rests on this check.
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt({ llmCalls: 1 }),
		});
		expect(report.issues).toContain("llmCalls must be 0");
	});

	it("rejects an absolute output path", () => {
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt({ files: [file("/etc/passwd", "")] }),
		});
		expect(report.issues.join()).toContain("unsafe path");
	});

	it("rejects a traversal segment anywhere in the path", () => {
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt({ files: [file("src/../../out.ts", "export {};")] }),
		});
		expect(report.issues.join()).toContain("unsafe path");
	});

	it("accepts an ordinary relative path", () => {
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.ts", "export const a = 1;")],
			}),
		});
		expect(report.ok).toBe(true);
	});

	it("reports a TypeScript syntax error with the compiler's own message", () => {
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.ts", "export const = ;")],
			}),
		});
		expect(report.ok).toBe(false);
		expect(report.issues.join()).toContain("src/app.ts:");
	});

	it("checks .tsx as well as .ts", () => {
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.tsx", "export const = ;")],
			}),
		});
		expect(report.ok).toBe(false);
	});

	it("does not compile a non-TypeScript file", () => {
		// A README full of prose is not a syntax error.
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("README.md", "export const = ;")],
			}),
		});
		expect(report.ok).toBe(true);
	});

	it("requires a bindle pattern to actually use the authoring surface", () => {
		// A pattern named bindle.* that renders no Bindle call is mislabelled,
		// and would teach the wrong shape to everyone who used it.
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt({ files: [file("src/app.ts", "export const a = 1;")] }),
		});
		expect(report.issues.join()).toContain("missing Bindle authoring surface");
	});

	it.each([
		"bindle(",
		"b.api",
		"b.web",
		"b.kv",
		"b.queue",
	])("accepts %s as the authoring surface", (surface) => {
		const report = validateRenderedPattern({
			pattern: pattern(),
			rendered: receipt({
				files: [file("src/app.ts", `export const a = ${surface}x);`)],
			}),
		});
		expect(report.issues.join()).not.toContain("missing Bindle");
	});

	it("exempts a guidance pattern from the authoring-surface rule", () => {
		// Guidance documents describe; they do not declare.
		const report = validateRenderedPattern({
			pattern: pattern({ id: "bindle.guidance.naming" }),
			rendered: receipt({
				patternId: "bindle.guidance.naming",
				files: [file("src/app.ts", "export const a = 1;")],
			}),
		});
		expect(report.issues.join()).not.toContain("missing Bindle");
	});

	it("rejects a hardcoded provider pin", () => {
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.ts", 'const r = "aws-us-east-1";')],
			}),
		});
		expect(report.issues.join()).toContain("prohibited provider pin or secret");
	});

	it("rejects a provider: literal", () => {
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.ts", 'const x = { "provider:": 1 };')],
			}),
		});
		expect(report.issues.join()).toContain("prohibited provider pin or secret");
	});

	it("rejects an embedded API key", () => {
		// A secret in a pattern propagates to every project that renders it.
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.ts", 'const k = "sk-abcdefghijklmnop1234";')],
			}),
		});
		expect(report.issues.join()).toContain("prohibited provider pin or secret");
	});

	it("does not flag a short sk- string that cannot be a key", () => {
		const report = validateRenderedPattern({
			pattern: pattern({ id: "guidance.note" }),
			rendered: receipt({
				patternId: "guidance.note",
				files: [file("src/app.ts", 'const k = "sk-short";')],
			}),
		});
		expect(report.ok).toBe(true);
	});

	it("accepts a receipt with no files at all", () => {
		expect(
			validateRenderedPattern({ pattern: pattern(), rendered: receipt() }).ok,
		).toBe(true);
	});
});

describe("parseEvalCases", () => {
	it("parses one case per line", () => {
		const cases = parseEvalCases(
			'{"id":"a","query":"http api"}\n{"id":"b","query":"kv"}',
		);
		expect(cases).toHaveLength(2);
		expect(cases[0]?.query).toBe("http api");
	});

	it("ignores blank lines and surrounding whitespace", () => {
		expect(parseEvalCases('\n\n{"id":"a","query":"q"}\n\n')).toHaveLength(1);
	});

	it("returns nothing for empty input", () => {
		expect(parseEvalCases("   ")).toEqual([]);
	});

	it("defaults expectedIds to empty when absent", () => {
		expect(parseEvalCases('{"id":"a","query":"q"}')[0]?.expectedIds).toEqual(
			[],
		);
	});

	it("keeps only string entries in expectedIds", () => {
		// A number in that array would otherwise reach retrieval as a bad id.
		const cases = parseEvalCases(
			'{"id":"a","query":"q","expectedIds":["x",7,null,"y"]}',
		);
		expect(cases[0]?.expectedIds).toEqual(["x", "y"]);
	});

	it("ignores a non-array expectedIds", () => {
		expect(
			parseEvalCases('{"id":"a","query":"q","expectedIds":"x"}')[0]
				?.expectedIds,
		).toEqual([]);
	});

	it("treats expectAbstain as true only when it is exactly true", () => {
		expect(
			parseEvalCases('{"id":"a","query":"q","expectAbstain":true}')[0]
				?.expectAbstain,
		).toBe(true);
		expect(
			parseEvalCases('{"id":"a","query":"q","expectAbstain":"yes"}')[0]
				?.expectAbstain,
		).toBe(false);
	});

	it("rejects a case with no id", () => {
		expect(() => parseEvalCases('{"query":"q"}')).toThrow(PatternParseError);
	});

	it("rejects a case with no query", () => {
		expect(() => parseEvalCases('{"id":"a"}')).toThrow(PatternParseError);
	});

	it("rejects a non-string id", () => {
		expect(() => parseEvalCases('{"id":7,"query":"q"}')).toThrow(
			PatternParseError,
		);
	});
});
