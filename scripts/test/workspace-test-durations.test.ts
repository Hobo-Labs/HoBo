import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	maxShardLoadSeconds,
	partitionUnitsByWeight,
	planDependentTests,
	planShardCountBalanced,
	planUnitLoadSeconds,
	MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS,
	readRepo,
	shardLoadSpreadSeconds,
	type TestPlan,
	testWorkspaceUnits,
} from "../ci/dependent-tests.mts";
import { loadWorkspaceDurations } from "../ci/workspace-test-durations.mts";

describe("workspace test duration balancing", () => {
	it("weights subset packages by selected test files", () => {
		const repo = readRepo();
		const plan = planDependentTests(
			["packages/redaction-test-harness/test/linear-time.test.ts"],
			repo,
		);
		assert.equal(plan.mode, "scoped");
		if (plan.mode !== "scoped") return;
		const durations = loadWorkspaceDurations();
		const subsetDir = "packages/hobo";
		assert.ok(plan.subsets.has(subsetDir));
		const whole = planUnitLoadSeconds(
			{
				mode: "scoped",
				full: [subsetDir],
				subsets: new Map(),
				skipped: [],
			},
			subsetDir,
			repo,
			durations,
		);
		const partial = planUnitLoadSeconds(plan, subsetDir, repo, durations);
		assert.ok(partial < whole);
	});

	it("keeps the slowest shard under the target for a scoped plan", () => {
		const plan: TestPlan = {
			mode: "scoped",
			full: ["packages/hobo", "packages/core", "packages/ci"],
			subsets: new Map([["packages/code", ["test/x.test.ts"]]]),
			skipped: [],
		};
		const durations = loadWorkspaceDurations();
		const count = planShardCountBalanced(plan, [], 8, 120, durations);
		const units = [
			"packages/hobo",
			"packages/core",
			"packages/ci",
			"packages/code",
		];
		const peak = maxShardLoadSeconds(units, durations, count);
		assert.ok(
			peak <= 120,
			`peak load ${peak}s exceeds 120s cap with ${count} shards`,
		);
	});

	it("isolates the heaviest workspace on its own shard when needed", () => {
		const durations = loadWorkspaceDurations();
		const parts = partitionUnitsByWeight(
			["packages/hobo", "packages/core", "packages/ci"],
			durations,
			2,
		);
		const hoboShard = parts.findIndex((shard) =>
			shard.includes("packages/hobo"),
		);
		assert.equal(parts[hoboShard]?.length, 1);
	});

	it("spreads measured slow workspaces across main shards", () => {
		const durations = loadWorkspaceDurations();
		const repo = readRepo();
		const plan = planDependentTests([], repo);
		const units = testWorkspaceUnits(plan, repo.workspaces);
		const parts = partitionUnitsByWeight(units, durations, 4);
		const heavy = ["packages/cli", "packages/hobo", "packages/ci-gh-actions"];
		for (const dir of heavy) {
			const shard = parts.findIndex((part) => part.includes(dir));
			assert.ok(shard >= 0, `${dir} missing from repo-wide partition`);
			const collocated = heavy.filter((other) => parts[shard]?.includes(other));
			assert.ok(
				collocated.length <= 1,
				`${heavy.join(", ")} collided on shard ${shard}: ${collocated.join(", ")}`,
			);
		}
		const loads = parts.map((part) =>
			part.reduce(
				(sum, dir) =>
					sum + (durations.seconds.get(dir) ?? durations.defaultSeconds),
				0,
			),
		);
		const spread = Math.max(...loads) - Math.min(...loads);
		assert.ok(
			spread <= MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS,
			`repo-wide shard loads diverged by ${spread}s: ${loads.join(", ")}`,
		);
	});

	it("adds shards until scoped loads spread within the main cap", () => {
		const durations = loadWorkspaceDurations();
		const repo = readRepo();
		const plan = planDependentTests(
			["docs/maintenance/ci-performance.md"],
			repo,
		);
		if (plan.mode !== "scoped") return;
		const units = testWorkspaceUnits(plan, repo.workspaces);
		if (units.length < 2) return;
		const count = planShardCountBalanced(
			plan,
			repo.workspaces,
			8,
			180,
			durations,
			undefined,
			repo,
			MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS,
		);
		const spread = shardLoadSpreadSeconds(units, durations, count, (unit) =>
			planUnitLoadSeconds(plan, unit, repo, durations),
		);
		assert.ok(spread <= MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS);
	});
});
