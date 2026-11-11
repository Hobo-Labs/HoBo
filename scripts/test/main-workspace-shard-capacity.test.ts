import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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

	it("never plans more shards than the fleet parallel cap", () => {
		const plan = scoped(40);
		for (const cap of [1, 2, 4, 6, 8]) {
			const planned = planMainWorkspaceShardCount(plan, cap);
			assert.ok(
				planned.count <= cap,
				`planned ${planned.count} shards exceeds cap ${cap}`,
			);
			assert.equal(planned.parallelCap, cap);
		}
	});

	it("packs multiple workspaces into each shard when the cap is small", () => {
		const durations = loadWorkspaceDurations();
		const plan = scoped(40);
		const { count } = planMainWorkspaceShardCount(plan, 2, { durations });
		assert.equal(count, 2);
	});
});
