import assert from "node:assert/strict";
import { test } from "node:test";

import { unitTestCoverageProblems } from "../lib/unit-test-coverage.ts";

test("turbo unit tasks cover the old runner and every root shard input", () => {
	assert.deepEqual(unitTestCoverageProblems(), []);
});
