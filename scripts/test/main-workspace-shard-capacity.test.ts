import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAIN_WORKSPACE_SHARD_BUDGET_SECONDS,
	MAX_MAIN_WORKSPACE_SHARDS,
	minimumScopedShardCount,
	planMainWorkspaceShardCount,
	type TestPlan,
} from "../ci/dependent-tests.mts";
import { loadWorkspaceDurations } from "../ci/workspace-test-durations.mts";

describe("main workspace shard capacity", () => {
	const scoped = (suites: number): TestPlan => ({
		mode: "scoped",
		full: Array.from({ length: suites }, (_, index) => `packages/p${index}`),
		subsets: new Map(),
		skipped: [],
	});

	it("stays within the fleet parallel cap while the slowest shard fits its budget", () => {
		const plan = scoped(40);
		for (const cap of [1, 2, 4, 6, 8]) {
			const planned = planMainWorkspaceShardCount(plan, cap);
			assert.equal(planned.parallelCap, cap);
			if (planned.count > cap) {
				// Over the cap only as far as the slowest shard needs to fit.
				assert.ok(
					planned.peakShardSeconds <= MAIN_WORKSPACE_SHARD_BUDGET_SECONDS ||
						planned.count === MAX_MAIN_WORKSPACE_SHARDS,
					`planned ${planned.count} shards over cap ${cap}, slowest ${planned.peakShardSeconds}s`,
				);
			}
		}
	});

	it("adds shards past the cap when a repo-wide plan would outrun the 20-minute job cap", () => {
		// Run 43130657460: repo-wide, cap 4, slowest shard planned at 1375 s,
		// cancelled at the 19-minute step limit (finding 117).
		const all: TestPlan = { mode: "all", reason: "lockfile changed" };
		const planned = planMainWorkspaceShardCount(all, 4);
		assert.ok(planned.count > 4, `planned ${planned.count} shards`);
		assert.ok(planned.count <= MAX_MAIN_WORKSPACE_SHARDS);
		assert.ok(
			planned.peakShardSeconds <= MAIN_WORKSPACE_SHARD_BUDGET_SECONDS,
			`slowest shard ${planned.peakShardSeconds}s`,
		);
	});

	it("raises shard floor when many scoped suites are in the plan", () => {
		const plan: TestPlan = {
			mode: "scoped",
			full: [
				"packages/ci",
				"packages/ci-gh-actions",
				"packages/ci-vercel",
				"packages/hobo",
				"packages/data-postgres",
			],
			subsets: new Map([
				["packages/ci-agent", ["test/daemon.test.ts"]],
				["packages/ci-ado", ["test/ado.test.ts"]],
			]),
			skipped: [],
		};
		assert.equal(minimumScopedShardCount(plan, 4), 4);
		const { count } = planMainWorkspaceShardCount(plan, 4);
		assert.equal(count, 4);
	});

	it("packs multiple workspaces into each shard when the cap is small", () => {
		const durations = loadWorkspaceDurations();
		const plan = scoped(40);
		const { count } = planMainWorkspaceShardCount(plan, 2, { durations });
		assert.equal(count, 2);
	});
});
