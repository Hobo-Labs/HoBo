import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	maxShardLoadSeconds,
	partitionUnitsByWeight,
	planShardCountBalanced,
	type TestPlan,
} from "../ci/dependent-tests.mts";
import { loadWorkspaceDurations } from "../ci/workspace-test-durations.mts";

describe("workspace test duration balancing", () => {
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
});
