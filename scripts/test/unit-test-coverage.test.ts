import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { unitTestCoverageProblems } from "../lib/unit-test-coverage.ts";
import {
	DRAFT_VITEST_SHARDS,
	draftProofDirectory,
	draftUnitTestFiles,
	selectDraftShard,
} from "../lib/unit-test-selection.ts";

test("turbo unit tasks cover the old runner and every root shard input", () => {
	assert.deepEqual(unitTestCoverageProblems(), []);
});

test("a draft proof directory never spans two shards", () => {
	const files = draftUnitTestFiles();
	const assignments = Array.from({ length: DRAFT_VITEST_SHARDS }, (_, index) =>
		selectDraftShard(files, { index, count: DRAFT_VITEST_SHARDS }),
	);
	const proofShards = new Map<string, number>();
	const assignedFiles: string[] = [];
	for (const [index, shardFiles] of assignments.entries()) {
		for (const file of shardFiles) {
			assignedFiles.push(file);
			const directory = draftProofDirectory(file);
			const previous = proofShards.get(directory);
			assert.ok(
				previous === undefined || previous === index,
				`${directory} spans shards ${previous} and ${index}`,
			);
			proofShards.set(directory, index);
		}
	}
	assert.equal(assignedFiles.length, files.length);
	assert.equal(new Set(assignedFiles).size, files.length);
	assert.deepEqual(
		assignments,
		Array.from({ length: DRAFT_VITEST_SHARDS }, (_, index) =>
			selectDraftShard(files, { index, count: DRAFT_VITEST_SHARDS }),
		),
	);
});

test("the measured heavy draft proofs occupy separate shards", () => {
	const files = draftUnitTestFiles();
	const heavyProofs = [
		"src/draft/technical-proofs/componentize-js-determinism-spike",
		"src/draft/technical-proofs/hobo-componentize",
		"src/draft/technical-proofs/hobo-wit-toolchain-contract",
		"src/draft/technical-proofs/hobo-new-scaffold-contract",
		"src/draft/technical-proofs/planner-dag-skeleton-contract",
	];
	const shards = heavyProofs.map((proof) =>
		Array.from({ length: DRAFT_VITEST_SHARDS }, (_, index) => index).find(
			(index) =>
				selectDraftShard(files, {
					index,
					count: DRAFT_VITEST_SHARDS,
				}).some((file) => draftProofDirectory(file) === proof),
		),
	);
	assert.ok(shards.every((shard) => shard !== undefined));
	assert.equal(new Set(shards).size, heavyProofs.length);
});

test("generated draft shard tasks and scripts have no drift", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/generate-unit-test-shards.ts", "--check"],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
});
