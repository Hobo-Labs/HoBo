import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replayFailed } from "../ci/plan-replay.mts";

describe("the replay's exit status", () => {
	const totals = (before: number, after: number) =>
		new Map([
			["before", { misses: before }],
			["after", { misses: after }],
		]);

	it("answers for the current planner, not the one it is compared with", () => {
		assert.equal(replayFailed(totals(41, 0)), false);
		assert.equal(replayFailed(totals(0, 1)), true);
		assert.equal(replayFailed(totals(41, 1)), true);
		assert.equal(replayFailed(new Map([["after", { misses: 0 }]])), false);
	});
});
