import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	compileSafeFtsQuery,
	loadPatternCatalog,
	PatternParseError,
	renderPattern,
} from "../src/index.js";

const catalog = loadPatternCatalog();

describe("pattern security", () => {
	it("never interpolates raw FTS operators", () => {
		expect(compileSafeFtsQuery(["web", 'api" OR 1=1'])).toBe(
			'"web" "api OR 1=1"',
		);
	});

	it("rejects apply paths that escape the isolation root", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-pat-sec-"));
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: "bindle.named",
				isolationRoot: root,
				targetPath: "../outside.ts",
				isolationRunId: "sec-1",
			}),
		).toThrow(PatternParseError);
	});

	it("rejects secret-like or path-escaping render params", () => {
		const pattern = catalog.patterns.find((item) => item.id === "bindle.named");
		if (!pattern) throw new Error("missing bindle.named");
		expect(() =>
			renderPattern({
				catalog,
				pattern,
				params: { resourceName: "../etc" },
			}),
		).toThrow(PatternParseError);
	});
});
