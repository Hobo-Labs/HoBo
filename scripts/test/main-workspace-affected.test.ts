import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mainGateScope } from "../ci/affected-lanes.mts";
import {
	intersectScopedPlanWithTurboAffected,
	planCommands,
	planDependentTests,
	planUnits,
	readRepo,
} from "../ci/dependent-tests.mts";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("main workspace affected-only", () => {
	it("runs repo-wide workspace tests only when the gate widens", () => {
		assert.deepEqual(
			mainGateScope(["packages/core/src/x.ts"]).mode,
			"affected",
		);
		assert.deepEqual(mainGateScope(["pnpm-lock.yaml"]).mode, "repo-wide");
	});

	it("passes turbo --affected when HOBO_TURBO_USE_AFFECTED is set", () => {
		const prior = process.env.HOBO_TURBO_USE_AFFECTED;
		process.env.HOBO_TURBO_USE_AFFECTED = "1";
		try {
			const commands = planCommands(
				{ mode: "all", reason: "test" },
				[],
				"2",
				() => [],
			);
			assert.ok(commands[0]?.includes("--affected"));
		} finally {
			if (prior === undefined) delete process.env.HOBO_TURBO_USE_AFFECTED;
			else process.env.HOBO_TURBO_USE_AFFECTED = prior;
		}
	});

	it("intersects a fat planner closure with turbo affected directories", () => {
		const repo = readRepo();
		const fat = planDependentTests(
			["packages/redaction-test-harness/test/linear-time.test.ts"],
			repo,
		);
		assert.equal(fat.mode, "scoped");
		const narrow = intersectScopedPlanWithTurboAffected(
			fat,
			new Set(["packages/redaction-test-harness", "packages/hobo"]),
			repo.workspaces,
		);
		assert.ok(
			planUnits(narrow, repo.workspaces).length <
				planUnits(fat, repo.workspaces).length,
		);
		assert.equal(narrow.mode, "scoped");
		if (narrow.mode !== "scoped") return;
		assert.deepEqual(narrow.full, ["packages/redaction-test-harness"]);
		assert.ok(narrow.subsets.has("packages/hobo"));
	});

	it("plans one package and turbo dependents for a single-package test edit", () => {
		const repo = readRepo();
		const path = "packages/ci-agent/test/daemon-config.test.ts";
		const raw = planDependentTests([path], repo);
		assert.equal(raw.mode, "scoped");
		if (raw.mode !== "scoped") return;
		assert.ok(raw.full.includes("packages/ci-agent"));
		const affected = new Set(["packages/ci-agent", "packages/hobo"]);
		const aligned = intersectScopedPlanWithTurboAffected(
			raw,
			affected,
			repo.workspaces,
		);
		assert.deepEqual(
			[...planUnits(aligned, repo.workspaces)].sort(),
			["packages/ci-agent", "packages/hobo"].sort(),
		);
	});

	it("intersects import-walk plans with turbo --affected before main sharding", () => {
		const planner = readFileSync(
			join(import.meta.dirname, "..", "ci", "plan-main-workspace-shards.mts"),
			"utf8",
		);
		const dependent = readFileSync(
			join(import.meta.dirname, "..", "ci", "dependent-tests.mts"),
			"utf8",
		);
		assert.match(planner, /planDependentTestsForTurboAffected/u);
		assert.match(planner, /planHasWorkspaceWork/u);
		assert.match(planner, /count === 0[\s\S]*"\[\]"/u);
		assert.match(workflow, /WORKSPACE_RESULT" != "skipped"/u);
		assert.match(planner, /TURBO_SCM_BASE/u);
		assert.match(dependent, /planDependentTestsForTurboAffected/u);
		assert.match(dependent, /intersectScopedPlanWithTurboAffected/u);
	});

	it("runs the plan job beside the deps image job", () => {
		const planStart = workflow.indexOf("  main-gate-plan:");
		const mainStart = workflow.indexOf("  main-gate:", planStart);
		const plan = workflow.slice(planStart, mainStart);
		assert.match(plan, /plan-main-workspace-shards\.mts/u);
		assert.match(plan, /needs: \[ci-runner-image\]/u);
		assert.doesNotMatch(plan, /pnpm-install\.mts/u);
		assert.match(plan, /HOBO_TURBO_INVOKER: mise/u);
	});

	it("wires TURBO_SCM_BASE and HOBO_TURBO_USE_AFFECTED on main workspace shards", () => {
		const start = workflow.indexOf("  main_workspace_tests:");
		const finish = workflow.indexOf("  main_gate_finish:", start);
		const block = workflow.slice(start, finish);
		assert.match(
			block,
			/TURBO_SCM_BASE: \$\{\{ needs\.main-gate-plan\.outputs\.main_base \}\}/u,
		);
		assert.match(block, /HOBO_TURBO_USE_AFFECTED:/u);
		assert.doesNotMatch(block, /HOBO_TURBO_CONCURRENCY: "1"/u);
	});
});
