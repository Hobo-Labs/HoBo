/**
 * The refusals on the pattern-application path.
 *
 * Applying a pattern rewrites a file the user already owns. That makes the
 * *refusals* the important half of this module, not the successes: a merge that
 * proceeded when it should not have would silently corrupt somebody's source,
 * and the damage would be discovered at compile time in a file nobody
 * associated with running a pattern.
 *
 * Two families are covered here.
 *
 * **Containment.** `assertSafe` is what keeps every write inside the isolation
 * root. The path is checked twice — once as a string (absolute, or containing
 * `..`) and once after `normalize(join(...))` — because a path can be innocuous
 * character-by-character and still resolve outside the root.
 *
 * **Structural preconditions.** The TypeScript merge only knows how to reason
 * about one specific shape: a single `bindle(...)` call with a callback body.
 * Every other shape is refused by name rather than guessed at, because a merge
 * into a file the transform did not understand is exactly the corruption case.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterAll, describe, expect, it } from "vitest";

import {
	PatternKind,
	type PatternManifest,
	PatternManifestSchema,
	PatternMaturity,
	RenderingKind,
} from "../src/_generated/patterns_pb.js";
import type { PatternCatalog } from "../src/catalog.js";
import { PatternParseError } from "../src/parse.js";
import {
	applyPatternPlan,
	planPatternApplication,
} from "../src/typescript-apply.js";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

/** A catalog on disk whose single pattern renders `body` to `outputFile`. */
function catalogWith(body: string, outputFile = "src/app.ts"): PatternCatalog {
	const root = tempRoot("hobo-patterns-apply-cat-");
	const dir = join(root, "probe");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pattern.json"), JSON.stringify({ id: "probe.p" }));
	writeFileSync(join(dir, "body.ts"), body, "utf8");
	const pattern: PatternManifest = create(PatternManifestSchema, {
		id: "probe.p",
		version: "1.0.0",
		kind: PatternKind.GUIDANCE,
		maturity: PatternMaturity.STABLE,
		title: "probe",
		intent: "probe",
		parameters: [],
		renderings: [
			{
				renderingId: "probe.ts",
				kind: RenderingKind.FILE,
				isDefault: true,
				outputFiles: [outputFile],
				sourcePath: "body.ts",
			},
		],
	});
	return { root, digest: "d", patterns: [pattern] };
}

/** An isolation root with `targetPath` pre-populated. */
function isolationWith(targetPath: string, contents: string): string {
	const root = tempRoot("hobo-patterns-apply-iso-");
	const file = join(root, targetPath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, contents, "utf8");
	return root;
}

const BINDLE_SNIPPET = `import { bindle } from "@hobo/bindles";

export default bindle("app", (b) => {
  const store = b.kv("store");
  return { store };
});
`;

function apply(input: {
	catalog: PatternCatalog;
	isolationRoot: string;
	targetPath?: string;
}) {
	return applyPatternPlan({
		catalog: input.catalog,
		patternId: "probe.p",
		isolationRoot: input.isolationRoot,
		targetPath: input.targetPath ?? "src/app.ts",
		isolationRunId: "run-1",
	});
}

describe("path containment", () => {
	it("refuses an absolute target path", () => {
		// The string check. An absolute path would ignore the isolation root
		// entirely and write wherever it names.
		expect(() =>
			planPatternApplication({
				catalog: catalogWith("export const a = 1;\n"),
				patternId: "probe.p",
				isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
				targetPath: "/etc/passwd",
				isolationRunId: "run-1",
			}),
		).toThrow(/unsafe path/u);
	});

	it("refuses traversal anywhere in the target path", () => {
		// Not just a leading `..`. `a/../../b` is character-wise unremarkable and
		// resolves two levels above the root once normalised.
		for (const targetPath of ["../out.ts", "a/../../out.ts", ".."]) {
			expect(() =>
				planPatternApplication({
					catalog: catalogWith("export const a = 1;\n"),
					patternId: "probe.p",
					isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
					targetPath,
					isolationRunId: "run-1",
				}),
			).toThrow(PatternParseError);
		}
	});

	it("accepts a plain relative path inside the root", () => {
		const plan = planPatternApplication({
			catalog: catalogWith("export const a = 1;\n"),
			patternId: "probe.p",
			isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
			targetPath: "src/deep/app.ts",
			isolationRunId: "run-1",
		});
		expect(plan.targetPath).toBe("src/deep/app.ts");
	});
});

describe("planPatternApplication", () => {
	it("refuses an unknown pattern id", () => {
		expect(() =>
			planPatternApplication({
				catalog: catalogWith("export const a = 1;\n"),
				patternId: "not.here",
				isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
				targetPath: "src/app.ts",
				isolationRunId: "run-1",
			}),
		).toThrow(/unknown pattern not\.here/u);
	});

	it("records an empty preimage when the target does not exist yet", () => {
		// A new file has nothing to compare against. An empty list says "no
		// expectation", which is different from a digest of the empty string —
		// the latter would make an apply refuse once the file appeared.
		const plan = planPatternApplication({
			catalog: catalogWith("export const a = 1;\n"),
			patternId: "probe.p",
			isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
			targetPath: "src/app.ts",
			isolationRunId: "run-1",
		});
		expect(plan.expectedPreimage).toEqual([]);
	});

	it("records the target's digest as the expected preimage when it exists", () => {
		// The preimage is what makes an apply detectably stale: if the file
		// changed between plan and apply, the recorded digest no longer matches.
		const plan = planPatternApplication({
			catalog: catalogWith("export const a = 1;\n"),
			patternId: "probe.p",
			isolationRoot: isolationWith("src/app.ts", "existing\n"),
			targetPath: "src/app.ts",
			isolationRunId: "run-1",
		});
		expect(plan.expectedPreimage).toHaveLength(1);
		expect(plan.expectedPreimage[0]).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("always requires promotion", () => {
		// An apply writes into the isolation root only. Promotion is the separate,
		// explicit step that moves it into the real tree, and a plan that did not
		// say so would invite a caller to treat the isolated write as the change.
		const plan = planPatternApplication({
			catalog: catalogWith("export const a = 1;\n"),
			patternId: "probe.p",
			isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
			targetPath: "src/app.ts",
			isolationRunId: "run-1",
		});
		expect(plan.promotionRequired).toBe(true);
	});

	it("carries the run id and source root through", () => {
		const root = tempRoot("hobo-patterns-apply-iso-");
		const plan = planPatternApplication({
			catalog: catalogWith("export const a = 1;\n"),
			patternId: "probe.p",
			isolationRoot: root,
			targetPath: "src/app.ts",
			isolationRunId: "run-42",
		});
		expect(plan.isolationRunId).toBe("run-42");
		expect(plan.sourceRoot).toBe(root);
	});
});

describe("applyPatternPlan into an empty tree", () => {
	it("writes the rendered file and reports it changed", () => {
		const root = tempRoot("hobo-patterns-apply-iso-");
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n"),
			isolationRoot: root,
		});
		expect(receipt.changedFiles).toEqual(["src/app.ts"]);
		expect(receipt.idempotent).toBe(false);
		expect(receipt.reasonCode).toBe("applied-isolation");
		expect(receipt.promotionRequired).toBe(true);
		expect(receipt.promotionRef).toBe("caller-promotes");
	});

	it("is idempotent on a second run", () => {
		// The property that makes an apply safe to retry. A second run that
		// reported a change would make a caller believe the pattern kept
		// modifying the file.
		const root = tempRoot("hobo-patterns-apply-iso-");
		const catalog = catalogWith("export const a = 1;\n");
		apply({ catalog, isolationRoot: root });
		const second = apply({ catalog, isolationRoot: root });
		expect(second.changedFiles).toEqual([]);
		expect(second.idempotent).toBe(true);
		expect(second.reasonCode).toBe("idempotent");
	});

	it("reports a postimage digest for every rendered file", () => {
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n"),
			isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
		});
		expect(receipt.postimage).toHaveLength(1);
		expect(receipt.postimage[0]).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("reports zero LLM usage", () => {
		// Application is a deterministic AST transform, not a model call.
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n"),
			isolationRoot: tempRoot("hobo-patterns-apply-iso-"),
		});
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("creates intermediate directories for a nested target", () => {
		const root = tempRoot("hobo-patterns-apply-iso-");
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n", "src/a/b/c.ts"),
			isolationRoot: root,
			targetPath: "src/a/b/c.ts",
		});
		expect(receipt.changedFiles).toEqual(["src/a/b/c.ts"]);
	});
});

describe("non-TypeScript merge refusals", () => {
	it("refuses to merge into a file it did not write and cannot parse structurally", () => {
		// The blunt guard: the target is non-empty, does not contain the rendered
		// text, and neither side mentions `bindle(`. Overwriting would destroy
		// whatever the user had; appending would produce a file neither of them
		// intended. Refusing names the limitation.
		expect(() =>
			apply({
				catalog: catalogWith("export const a = 1;\n"),
				isolationRoot: isolationWith("src/app.ts", "const untouched = 1;\n"),
			}),
		).toThrow(/unsupported language or non-TypeScript merge/u);
	});

	it("treats a target that already contains the rendered text as idempotent", () => {
		// The substring check is what makes a re-apply after manual edits around
		// the pattern a no-op rather than a refusal.
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n"),
			isolationRoot: isolationWith(
				"src/app.ts",
				"// preamble\nexport const a = 1;\n// trailer\n",
			),
		});
		expect(receipt.changedFiles).toEqual([]);
		expect(receipt.idempotent).toBe(true);
	});

	it("treats a whitespace-only target as empty", () => {
		// `previous.trim() === ""`. A file containing only a newline is not
		// meaningfully occupied, and refusing there would make an apply fail on a
		// freshly-touched file.
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n"),
			isolationRoot: isolationWith("src/app.ts", "\n\n   \n"),
		});
		expect(receipt.changedFiles).toEqual(["src/app.ts"]);
	});
});

describe("structural merge refusals", () => {
	it("refuses a snippet that is not valid TypeScript", () => {
		// Checked before anything is written. A snippet that failed to parse
		// would otherwise be spliced in as text and break the target.
		expect(() =>
			apply({
				catalog: catalogWith("bindle(\n"),
				isolationRoot: isolationWith("src/app.ts", BINDLE_SNIPPET),
			}),
		).toThrow(/snippet is not valid TypeScript/u);
	});

	it("refuses when the target itself has syntax errors", () => {
		// Merging into a file that does not parse would produce an AST-derived
		// edit at an offset that means nothing, corrupting it further.
		expect(() =>
			apply({
				catalog: catalogWith(BINDLE_SNIPPET),
				isolationRoot: isolationWith(
					"src/app.ts",
					'import { bindle } from "@hobo/bindles";\nbindle(\n',
				),
			}),
		).toThrow(/target has source syntax errors/u);
	});

	it("refuses a target with more than one bindle definition", () => {
		// Ambiguous: the transform would have to guess which definition the
		// pattern belongs in, and guessing wrong puts a resource in the wrong
		// bindle without any error.
		const twoBindles = `import { bindle } from "@hobo/bindles";

export const one = bindle("one", (b) => {
  return {};
});

export const two = bindle("two", (b) => {
  return {};
});
`;
		expect(() =>
			apply({
				catalog: catalogWith(BINDLE_SNIPPET),
				isolationRoot: isolationWith("src/app.ts", twoBindles),
			}),
		).toThrow(/multiple ambiguous Bindle definitions/u);
	});

	it("names the dynamic-shape case separately from an unsupported one", () => {
		// A target that mentions `bindle(` or imports `@hobo/bindles` but has no
		// call the parser recognised is a *dynamic* shape — built at runtime,
		// aliased, or behind a factory. Saying so tells the author the transform
		// cannot be made to work here, rather than implying they wrote something
		// malformed.
		const dynamic = `import { bindle } from "@hobo/bindles";

const make = bindle;
export default make("app", (b) => ({}));
`;
		expect(() =>
			apply({
				catalog: catalogWith(BINDLE_SNIPPET),
				isolationRoot: isolationWith("src/app.ts", dynamic),
			}),
		).toThrow(/dynamic code shapes that cannot be safely transformed/u);
	});

	it("refuses a bindle call whose second argument is not a callback", () => {
		// The transform edits inside the callback body. Without one there is
		// nowhere to put the pattern's statements.
		const noCallback = `import { bindle } from "@hobo/bindles";

export default bindle("app", {});
`;
		expect(() =>
			apply({
				catalog: catalogWith(BINDLE_SNIPPET),
				isolationRoot: isolationWith("src/app.ts", noCallback),
			}),
		).toThrow(/unsupported existing TypeScript shape/u);
	});
});
