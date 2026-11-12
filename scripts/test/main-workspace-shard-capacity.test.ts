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
			assert.ok(
				planned.count <= cap,
				`planned ${planned.count} shards over cap ${cap}`,
			);
		}
	});

	// Run 43130657460: repo-wide at cap 4, slowest shard planned at 1375 s,
	// cancelled at the 19-minute step limit (finding 117).
	const fiveMinuteSuites = {
		defaultSeconds: 300,
		seconds: new Map<string, number>(),
	};

	it("adds shards past the cap, no more than the slowest shard needs", () => {
		// Ten 5-minute suites: two fit the 12-minute budget per shard, so five
		// shards, where the cap of two would leave 25 minutes on each.
		const planned = planMainWorkspaceShardCount(scoped(10), 2, {
			durations: fiveMinuteSuites,
		});
		assert.equal(planned.count, 5);
		assert.ok(planned.peakShardSeconds <= MAIN_WORKSPACE_SHARD_BUDGET_SECONDS);
	});

	it("stops adding shards when one workspace alone is over budget", () => {
		const planned = planMainWorkspaceShardCount(scoped(3), 1, {
			durations: { defaultSeconds: 1000, seconds: new Map<string, number>() },
		});
		assert.equal(planned.count, 3);
		assert.ok(planned.count < MAX_MAIN_WORKSPACE_SHARDS);
		assert.equal(planned.peakShardSeconds, 1000);
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
