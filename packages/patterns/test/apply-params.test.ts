/**
 * The params a pattern application accepts.
 *
 * `parseApplicationRequest` is the boundary: it takes any scalar — string,
 * number or boolean — and coerces it to a string, and refuses anything else.
 * `applyPatternPlan` and `planPatternApplication` must keep accepting what that
 * parser accepts. Narrowing their declared type to strings would turn a
 * numeric flag a caller passes today into a compile error for no runtime gain.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	loadPatternCatalog,
	parseApplicationRequest,
	planPatternApplication,
} from "../src/index.js";

const catalog = loadPatternCatalog();
const roots: string[] = [];

function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-apply-params-"));
	roots.push(dir);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "src", "bindle.ts"),
		`import { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  return {};\n});\n`,
	);
	return dir;
}

afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("application params", () => {
	it("applies with numeric and boolean params, as the request parser coerces them", () => {
		const dir = root();
		const receipt = applyPatternPlan({
			catalog,
			patternId: "bindle.resource.api",
			isolationRoot: dir,
			targetPath: "src/bindle.ts",
			isolationRunId: "params-scalars",
			params: { resourceName: "shop", retries: 3, dryRun: false },
		});
		expect(receipt.changedFiles).toEqual(["src/bindle.ts"]);
		// The declared param reaches the rendered output; undeclared scalars
		// (retries/dryRun) are accepted by the parser and dropped by the plan.
		expect(readFileSync(join(dir, "src", "bindle.ts"), "utf8")).toContain(
			"const shop = b.api(",
		);
	});

	it("coerces numeric and boolean params to strings at the request boundary", () => {
		const parsed = parseApplicationRequest({
			patternId: "bindle.resource.api",
			isolationRoot: "/tmp/probe",
			targetPath: "src/bindle.ts",
			isolationRunId: "params-coerce",
			params: { retries: 3, dryRun: false },
		});
		expect(parsed.params).toEqual({ retries: "3", dryRun: "false" });
	});

	it("plans with numeric and boolean params", () => {
		const plan = planPatternApplication({
			catalog,
			patternId: "bindle.resource.api",
			isolationRoot: root(),
			targetPath: "src/bindle.ts",
			isolationRunId: "params-plan",
			params: { resourceName: "shop", retries: 3, dryRun: true },
		});
		expect(plan.isolationRunId).toBe("params-plan");
	});

	it("refuses a param that is not a scalar", () => {
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: "bindle.resource.api",
				isolationRoot: root(),
				targetPath: "src/bindle.ts",
				isolationRunId: "params-nested",
				params: { resourceName: "shop", nested: ["a"] },
			}),
		).toThrow("param nested must be a scalar");
	});
});
