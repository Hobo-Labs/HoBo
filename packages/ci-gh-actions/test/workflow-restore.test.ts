import { describe, expect, it } from "vitest";
import {
	applyWorkflowPlan,
	restoreWorkflowPlan,
} from "../src/workflow-init.js";

describe("restoreWorkflowPlan (S09)", () => {
	it("restores workflows modified by applyWorkflowPlan back to their exact original text", () => {
		const original = [
			"name: CI",
			"on: [push, pull_request]",
			"jobs:",
			"  test:",
			"    runs-on: ubuntu-24.04",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"      - run: pnpm test",
			"  lint:",
			"    runs-on: 'ubuntu-22.04'",
			"    steps:",
			"      - run: pnpm lint",
			"",
		].join("\n");

		const applied = applyWorkflowPlan(".github/workflows/ci.yml", original, [
			"all",
		]);
		expect(applied.changed).toEqual(["test", "lint"]);
		expect(applied.source).toContain("runs-on: hobo # was ubuntu-24.04");
		expect(applied.source).toContain("runs-on: 'hobo' # was ubuntu-22.04");

		const restored = restoreWorkflowPlan(applied.source);
		expect(restored.restored).toBe(2);
		expect(restored.source).toBe(original);
	});
});
