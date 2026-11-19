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
		expect(() =>
			apply({
				catalog: catalogWith("export const a = 1;\n"),
				isolationRoot: isolationWith("src/app.ts", "const untouched = 1;\n"),
			}),
		).toThrow(/unsupported language or non-TypeScript merge/u);
	});

	it("treats a target that already contains the rendered text as idempotent", () => {
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
		const receipt = apply({
			catalog: catalogWith("export const a = 1;\n"),
			isolationRoot: isolationWith("src/app.ts", "\n\n   \n"),
		});
		expect(receipt.changedFiles).toEqual(["src/app.ts"]);
	});
});

describe("structural merge refusals", () => {
	it("refuses a snippet that is not valid TypeScript", () => {
		expect(() =>
			apply({
				catalog: catalogWith("bindle(\n"),
				isolationRoot: isolationWith("src/app.ts", BINDLE_SNIPPET),
			}),
		).toThrow(/snippet is not valid TypeScript/u);
	});

	it("refuses when the target itself has syntax errors", () => {
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
