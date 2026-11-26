import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	loadPatternCatalog,
	PatternParseError,
} from "../src/index.js";

const catalog = loadPatternCatalog();

const NAMED = `import { bindle } from "@hobo/bindles";

/** keep this comment */
export default bindle("demo", (b) => {
  return {};
});
`;

describe("structural TypeScript apply", () => {
	it("inserts a resource into an existing bindle and stays idempotent", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-pat-ast-"));
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "bindle.ts"), NAMED);
		const first = applyPatternPlan({
			catalog,
			patternId: "bindle.resource.api",
			isolationRoot: root,
			targetPath: "src/bindle.ts",
			isolationRunId: "ast-1",
			params: { resourceName: "shop" },
		});
		expect(first.idempotent).toBe(false);
		const text = readFileSync(join(root, "src", "bindle.ts"), "utf8");
		expect(text).toContain("/** keep this comment */");
		expect(text).toContain("const shop = b.api");
		expect(text).toMatch(/return \{[^}]*shop/);
		const second = applyPatternPlan({
			catalog,
			patternId: "bindle.resource.api",
			isolationRoot: root,
			targetPath: "src/bindle.ts",
			isolationRunId: "ast-2",
			params: { resourceName: "shop" },
		});
		expect(second.idempotent).toBe(true);
		expect(readFileSync(join(root, "src", "bindle.ts"), "utf8")).toBe(text);
	});

	it("fails closed on two bindle definitions", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-pat-two-"));
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(
			join(root, "src", "bindle.ts"),
			`${NAMED}\nexport const other = bindle("x", (b) => ({ }));\n`,
		);
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: "bindle.resource.api",
				isolationRoot: root,
				targetPath: "src/bindle.ts",
				isolationRunId: "ast-3",
				params: { resourceName: "shop" },
			}),
		).toThrow(/ambiguous Bindle/);
	});

	it("fails closed on syntax errors", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-pat-syn-"));
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "bindle.ts"), "export default bindle(\n");
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: "bindle.named",
				isolationRoot: root,
				targetPath: "src/bindle.ts",
				isolationRunId: "ast-4",
			}),
		).toThrow(PatternParseError);
	});
});
