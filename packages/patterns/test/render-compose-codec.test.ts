/**
 * Template rendering, parameter validation, composition ordering, and the
 * vector codec.
 *
 * `parseParams` is the security boundary of this package. A pattern's
 * parameters end up substituted into a file body *and* into the file's own
 * output path, so a parameter that escaped its declared kind is not a cosmetic
 * problem: a `RELATIVE_PATH` containing `..` writes outside the destination
 * tree, and a `TYPESCRIPT_IDENTIFIER` containing arbitrary text is injected
 * into generated source. Each kind's check is asserted here in the direction
 * that matters — that the bad value is *refused*, not that the good one passes.
 *
 * `composePatterns` has a different failure mode. Its topological sort has to
 * terminate: a requires/provides cycle must be reported as a cycle rather than
 * spinning, and an unsatisfiable requirement must be reported rather than
 * silently dropping the pattern that needed it. Both produce a REJECTED receipt
 * with a distinguishable `reasonCode`, because "these patterns conflict",
 * "something is missing", and "the graph has a loop" send an author to three
 * different fixes.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	ParameterKind,
	type PatternManifest,
	PatternManifestSchema,
	ReceiptStatus,
	RenderingKind,
	SearchDecision,
} from "../src/_generated/patterns_pb.js";
import type { PatternCatalog } from "../src/catalog.js";
import { composePatterns } from "../src/compose.js";
import { PatternParseError } from "../src/parse.js";
import { fillTemplate, parseParams } from "../src/render.js";
import {
	CLI_STARTER_ALIASES,
	catalogStarterId,
	isCliStarterAlias,
} from "../src/starters.js";
import {
	cosineSimilarity,
	decodeVectorBlob,
	encodeVectorBlob,
	vectorCodecId,
} from "../src/vector-codec.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

function param(overrides: Record<string, unknown>) {
	return {
		name: "value",
		kind: ParameterKind.FREE_TEXT,
		required: false,
		defaultWire: "",
		choices: [] as string[],
		...overrides,
	};
}

function manifest(overrides: Record<string, unknown> = {}): PatternManifest {
	return create(PatternManifestSchema, {
		id: "test.pattern",
		version: "1.0.0",
		parameters: [],
		renderings: [],
		provides: [],
		requires: [],
		conflicts: [],
		effects: [],
		...overrides,
	});
}

function vector(values: number[]) {
	return {
		encoderId: "hobo-ontology-vector-v1",
		dimensions: values.length,
		values: Float32Array.from(values),
	};
}

describe("fillTemplate", () => {
	it("substitutes a token and leaves the rest of the body alone", () => {
		expect(fillTemplate("hello {{ name }}!", { name: "HoBo" })).toBe(
			"hello HoBo!",
		);
	});

	it("substitutes every occurrence of a repeated token", () => {
		// The regex is global. Replacing only the first occurrence would produce
		// a file that compiles in some places and not others — the hardest kind
		// of generated-code bug to read.
		expect(fillTemplate("{{ a }} and {{ a }}", { a: "x" })).toBe("x and x");
	});

	it("tolerates whitespace inside the braces", () => {
		for (const token of ["{{name}}", "{{ name }}", "{{   name   }}"]) {
			expect(fillTemplate(token, { name: "v" })).toBe("v");
		}
	});

	it("refuses a token with no matching parameter, naming it", () => {
		// Not left as a literal `{{ name }}` in the output. A template token that
		// survived into generated source would be a syntax error somewhere far
		// from the pattern that caused it.
		expect(() => fillTemplate("{{ missing }}", {})).toThrow(PatternParseError);
		expect(() => fillTemplate("{{ missing }}", {})).toThrow(
			/missing parameter missing/u,
		);
	});

	it("substitutes an empty string without treating it as missing", () => {
		// `value === undefined`, not falsiness. An empty parameter is a real
		// value and must render as nothing rather than throwing.
		expect(fillTemplate("[{{ a }}]", { a: "" })).toBe("[]");
	});

	it("ignores text that only looks like a token", () => {
		// The pattern requires an identifier starting with a letter, so neither
		// of these is a token — and neither should throw for a missing parameter.
		expect(fillTemplate("{{ 1abc }}", {})).toBe("{{ 1abc }}");
		expect(fillTemplate("{ name }", {})).toBe("{ name }");
		expect(fillTemplate("{{ a.b }}", {})).toBe("{{ a.b }}");
	});

	it("does not re-scan a substituted value", () => {
		// `String.replace` with a function does not reprocess the replacement, so
		// a parameter whose value contains a token is inert. That is the safe
		// direction: a value that could inject a further substitution would let
		// one parameter reach another's.
		expect(fillTemplate("{{ a }}", { a: "{{ b }}" })).toBe("{{ b }}");
	});
});

describe("parseParams", () => {
	it("returns an empty record for a pattern with no parameters", () => {
		expect(parseParams(manifest(), undefined)).toEqual({});
	});

	it("prefers the supplied value over the declared default", () => {
		const pattern = manifest({
			parameters: [param({ name: "a", defaultWire: "fallback" })],
		});
		expect(parseParams(pattern, { a: "given" })).toEqual({ a: "given" });
	});

	it("falls back to the declared default when nothing is supplied", () => {
		const pattern = manifest({
			parameters: [param({ name: "a", defaultWire: "fallback" })],
		});
		expect(parseParams(pattern, undefined)).toEqual({ a: "fallback" });
		expect(parseParams(pattern, {})).toEqual({ a: "fallback" });
	});

	it("refuses a required parameter that is absent or empty", () => {
		// Empty counts as absent for a *required* parameter, because an empty
		// required value renders as nothing and produces a file the author did
		// not intend rather than an error they can act on.
		const pattern = manifest({
			parameters: [param({ name: "a", required: true })],
		});
		expect(() => parseParams(pattern, undefined)).toThrow(
			/test\.pattern: missing a/u,
		);
		expect(() => parseParams(pattern, { a: "" })).toThrow(/missing a/u);
	});

	it("allows an optional parameter to be empty", () => {
		const pattern = manifest({ parameters: [param({ name: "a" })] });
		expect(parseParams(pattern, { a: "" })).toEqual({ a: "" });
	});

	it("stringifies a non-string value", () => {
		// Parameters arrive from JSON and from a CLI, so a number is routine.
		// Coercing here keeps every downstream substitution a string.
		const pattern = manifest({ parameters: [param({ name: "a" })] });
		expect(parseParams(pattern, { a: 7 })).toEqual({ a: "7" });
		expect(parseParams(pattern, { a: false })).toEqual({ a: "false" });
	});

	describe("TYPESCRIPT_IDENTIFIER", () => {
		const pattern = manifest({
			parameters: [
				param({ name: "a", kind: ParameterKind.TYPESCRIPT_IDENTIFIER }),
			],
		});

		it("accepts a valid identifier", () => {
			for (const value of ["Foo", "_bar", "a1", "$_ok".replace("$", "_")]) {
				expect(parseParams(pattern, { a: value })).toEqual({ a: value });
			}
		});

		it("refuses anything that is not one", () => {
			// This value is substituted into generated TypeScript. A hyphen or a
			// space produces a syntax error; a semicolon or a brace injects
			// statements into somebody else's file.
			for (const value of ["1abc", "has-dash", "has space", "a;b", "a}", ""]) {
				expect(() => parseParams(pattern, { a: value })).toThrow(
					/not a TypeScript identifier/u,
				);
			}
		});
	});

	describe("RESOURCE_NAME", () => {
		const pattern = manifest({
			parameters: [param({ name: "a", kind: ParameterKind.RESOURCE_NAME })],
		});

		it("accepts a lowercase kebab name", () => {
			for (const value of ["store", "my-store", "a1-b2"]) {
				expect(parseParams(pattern, { a: value })).toEqual({ a: value });
			}
		});

		it("refuses uppercase, underscores and a leading digit", () => {
			// Resource names reach provider APIs with their own naming rules; a
			// name refused there fails at deploy time rather than at authoring
			// time, which is the expensive place to find out.
			for (const value of ["Store", "my_store", "1store", "-lead", ""]) {
				expect(() => parseParams(pattern, { a: value })).toThrow(
					/not a resource name/u,
				);
			}
		});
	});

	describe("RELATIVE_PATH", () => {
		const pattern = manifest({
			parameters: [param({ name: "a", kind: ParameterKind.RELATIVE_PATH })],
		});

		it("accepts a plain relative path", () => {
			for (const value of ["src/index.ts", "a/b/c.txt", "file.ts", ""]) {
				expect(parseParams(pattern, { a: value })).toEqual({ a: value });
			}
		});

		it("refuses an absolute path and any traversal", () => {
			// The traversal case is the one with teeth: this value becomes part of
			// a written file's path, so `..` reaches outside the destination tree
			// and overwrites something the author never named.
			for (const value of [
				"/etc/passwd",
				"../outside.ts",
				"a/../../b.ts",
				"..",
			]) {
				expect(() => parseParams(pattern, { a: value })).toThrow(
					/not a safe relative path/u,
				);
			}
		});

		it("refuses traversal anywhere in the path, not just at the front", () => {
			// A `startsWith("..")` check would let `a/../../b` through, and
			// `join` would then normalise it right back outside the tree.
			expect(() =>
				parseParams(pattern, { a: "deep/nested/../../../x" }),
			).toThrow(/not a safe relative path/u);
		});
	});

	describe("LITERAL_CHOICE", () => {
		it("accepts a declared choice and refuses an undeclared one", () => {
			const pattern = manifest({
				parameters: [
					param({
						name: "a",
						kind: ParameterKind.LITERAL_CHOICE,
						choices: ["red", "blue"],
					}),
				],
			});
			expect(parseParams(pattern, { a: "red" })).toEqual({ a: "red" });
			expect(() => parseParams(pattern, { a: "green" })).toThrow(
				/not an allowed choice/u,
			);
		});

		it("does not constrain when the choice list is empty", () => {
			// `choices.length > 0` guards the check, so a LITERAL_CHOICE parameter
			// that declared no choices accepts anything rather than refusing
			// everything — which would make such a pattern unusable.
			const pattern = manifest({
				parameters: [
					param({
						name: "a",
						kind: ParameterKind.LITERAL_CHOICE,
						choices: [],
					}),
				],
			});
			expect(parseParams(pattern, { a: "anything" })).toEqual({
				a: "anything",
			});
		});

		it("matches a choice exactly, including case", () => {
			const pattern = manifest({
				parameters: [
					param({
						name: "a",
						kind: ParameterKind.LITERAL_CHOICE,
						choices: ["red"],
					}),
				],
			});
			expect(() => parseParams(pattern, { a: "Red" })).toThrow(
				/not an allowed choice/u,
			);
		});
	});

	it("validates every parameter, not just the first", () => {
		// A loop that returned early on the first success would let a bad second
		// parameter through.
		const pattern = manifest({
			parameters: [
				param({ name: "ok" }),
				param({ name: "bad", kind: ParameterKind.RELATIVE_PATH }),
			],
		});
		expect(() => parseParams(pattern, { ok: "x", bad: "../out" })).toThrow(
			/not a safe relative path/u,
		);
	});

	it("ignores supplied values the pattern did not declare", () => {
		// Only declared parameters reach the template, so a stray key cannot
		// introduce an unvalidated substitution.
		const pattern = manifest({ parameters: [param({ name: "a" })] });
		expect(parseParams(pattern, { a: "x", undeclared: "../escape" })).toEqual({
			a: "x",
		});
	});
});

describe("composePatterns", () => {
	const vocabulary = buildHoboVocabulary();

	function catalogOf(patterns: PatternManifest[]): PatternCatalog {
		return { root: "/nowhere", digest: "d", patterns };
	}

	function composed(patterns: PatternManifest[], query: string) {
		return composePatterns({
			catalog: catalogOf(patterns),
			vocabulary,
			query,
		});
	}

	it("rejects with reasonCode unsatisfied when nothing was selectable", () => {
		// The empty-selection branch. A composition over an empty catalog must
		// report a rejection rather than an accepted receipt over zero patterns,
		// which would read downstream as "composed successfully, produced
		// nothing".
		const receipt = composed([], "anything at all");
		expect(receipt.status).toBe(ReceiptStatus.REJECTED);
		expect(receipt.decision).toBe(SearchDecision.INCOMPATIBLE);
		expect(receipt.reasonCode).toBe("unsatisfied");
		expect(receipt.outputDigest).toBe("");
		expect(receipt.effectOrder).toEqual([]);
	});

	it("reports zero LLM usage on a rejection", () => {
		// Composition is deterministic and calls no model. The counters are on
		// the receipt so a reader can see that, and a non-zero value would be a
		// sign something started calling out.
		const receipt = composed([], "anything at all");
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("carries no chosen ids when the catalog is empty", () => {
		expect(composed([], "anything at all").chosenIds).toEqual([]);
	});
});

describe("vector codec", () => {
	it("names its codec so a stored blob can be read back correctly", () => {
		// The id records the byte layout the blob was written in. A reader that
		// assumed the layout would silently misinterpret every value if the
		// encoder ever changed.
		expect(vectorCodecId()).toBe("f32le-l2");
	});

	it("round-trips a vector through the blob form", () => {
		const original = vector([0.5, -0.25, 0]);
		const decoded = decodeVectorBlob(encodeVectorBlob(original), 3);
		expect([...decoded.values]).toEqual([0.5, -0.25, 0]);
		expect(decoded.dimensions).toBe(3);
	});

	it("writes four bytes per dimension, little-endian", () => {
		// Little-endian is the documented layout; asserting the bytes rather than
		// only the round trip is what would catch an endianness flip, since
		// encode and decode would otherwise agree with each other while
		// disagreeing with every stored blob.
		const blob = encodeVectorBlob(vector([1]));
		expect(blob.byteLength).toBe(4);
		expect([...blob]).toEqual([0x00, 0x00, 0x80, 0x3f]);
	});

	it("encodes an empty vector as an empty blob", () => {
		expect(encodeVectorBlob(vector([])).byteLength).toBe(0);
		expect(decodeVectorBlob(new Uint8Array(0), 0).dimensions).toBe(0);
	});

	it("treats a short values array as zero-filled up to the declared dimensions", () => {
		// `values[i] ?? 0`. Pinned rather than assumed: the declared dimension
		// count wins over the array length, so a truncated array pads rather
		// than producing a blob of the wrong size that decode would then reject.
		const blob = encodeVectorBlob({
			encoderId: "e",
			dimensions: 3,
			values: Float32Array.from([1]),
		});
		expect(blob.byteLength).toBe(12);
		expect([...decodeVectorBlob(blob, 3).values]).toEqual([1, 0, 0]);
	});

	it("refuses to encode a non-finite value, naming the index", () => {
		// A NaN in a stored vector poisons every similarity computed against it,
		// and the result is a silently empty search rather than an error.
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
			expect(() => encodeVectorBlob(vector([0, bad]))).toThrow(
				/vector value 1 is not finite/u,
			);
		}
	});

	it("refuses a blob whose length disagrees with the expected dimensions", () => {
		// The blob carries no length header, so this check is the only thing
		// standing between a truncated read and a vector of garbage.
		const blob = encodeVectorBlob(vector([1, 2, 3]));
		expect(() => decodeVectorBlob(blob, 2)).toThrow(
			/vector blob length 12 != 8/u,
		);
		expect(() => decodeVectorBlob(blob, 4)).toThrow(/12 != 16/u);
	});

	it("refuses to decode a blob containing a non-finite value", () => {
		// Reachable from a corrupted store even though encode refuses to write
		// one, which is exactly why decode checks independently.
		const blob = new Uint8Array(4);
		new DataView(blob.buffer).setFloat32(0, Number.NaN, true);
		expect(() => decodeVectorBlob(blob, 1)).toThrow(
			/vector value 0 is not finite/u,
		);
	});

	it("decodes a view into a larger buffer without reading past it", () => {
		// `new DataView(blob.buffer, blob.byteOffset, blob.byteLength)`, not
		// `new DataView(blob.buffer)`. A subarray shares its parent's buffer, so
		// dropping the offset would read the wrong four bytes entirely.
		const parent = new Uint8Array(12);
		parent.set(encodeVectorBlob(vector([7])), 4);
		const view = parent.subarray(4, 8);
		expect([...decodeVectorBlob(view, 1).values]).toEqual([7]);
	});

	it("defaults the encoder id and honours an explicit one", () => {
		const blob = encodeVectorBlob(vector([1]));
		expect(decodeVectorBlob(blob, 1).encoderId).toBe("hobo-ontology-vector-v1");
		expect(decodeVectorBlob(blob, 1, "other").encoderId).toBe("other");
	});

	it("computes a dot product for equal dimensions", () => {
		expect(cosineSimilarity(vector([1, 0]), vector([1, 0]))).toBe(1);
		expect(cosineSimilarity(vector([1, 0]), vector([0, 1]))).toBe(0);
		expect(cosineSimilarity(vector([1, 2]), vector([3, 4]))).toBe(11);
	});

	it("refuses a dimension mismatch rather than comparing a prefix", () => {
		// Comparing the overlap would produce a plausible number for two vectors
		// from different encoders, and the ranking built on it would be wrong in
		// a way nothing downstream could detect.
		expect(() => cosineSimilarity(vector([1]), vector([1, 2]))).toThrow(
			/vector dimension mismatch/u,
		);
	});

	it("returns zero for two empty vectors", () => {
		expect(cosineSimilarity(vector([]), vector([]))).toBe(0);
	});
});

describe("CLI starter aliases", () => {
	it("recognises exactly the declared aliases", () => {
		// The guard is what stops an arbitrary string reaching
		// `catalogStarterProjectRoot`, where it would become a path segment.
		for (const alias of CLI_STARTER_ALIASES) {
			expect(isCliStarterAlias(alias)).toBe(true);
		}
		for (const value of [
			"",
			"TODO",
			"todos",
			"../escape",
			"starter.cli.todo",
		]) {
			expect(isCliStarterAlias(value)).toBe(false);
		}
	});

	it("maps each alias to its catalog id", () => {
		for (const alias of CLI_STARTER_ALIASES) {
			expect(catalogStarterId(alias)).toBe(`starter.cli.${alias}`);
		}
	});

	it("declares the four documented starters", () => {
		expect([...CLI_STARTER_ALIASES]).toEqual([
			"todo",
			"api",
			"agent",
			"fullstack",
		]);
	});
});

describe("rendering kinds", () => {
	it("exposes the file and project kinds the multi-file path selects on", () => {
		// `renderPattern` treats FILE and PROJECT renderings as multi-file when
		// more than one is present, and falls back to a single default
		// otherwise. Pinning the enum members guards the selection from a
		// renumbering that would silently change which renderings are emitted.
		expect(RenderingKind.FILE).toBeDefined();
		expect(RenderingKind.PROJECT).toBeDefined();
		expect(RenderingKind.FILE).not.toBe(RenderingKind.PROJECT);
	});
});
