import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	EMPTY_PLAN_OUTPUTS,
	reusesMergeQueue,
} from "../ci/plan-main-workspace-shards.mts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

describe("main plan when the merge queue passed the tree", () => {
	it("reuses on a push only, and only on the literal true", () => {
		assert.equal(reusesMergeQueue("true", "push"), true);
		assert.equal(reusesMergeQueue(" true ", "push"), true);
		for (const setting of [undefined, "", "false", "1", "yes"])
			assert.equal(reusesMergeQueue(setting, "push"), false, String(setting));
		for (const event of ["schedule", "workflow_dispatch", "merge_group"])
			assert.equal(reusesMergeQueue("true", event), false, event);
	});

	it("plans no shards and resolves no base, without git, turbo or the network", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"scripts/ci/plan-main-workspace-shards.mts",
			],
			{
				cwd: REPO_ROOT,
				env: {
					PATH: "",
					EVENT_NAME: "push",
					HEAD_SHA: "f0b586a1a8bb83c39ed13ba11753ef8b2dc66f29",
					MAIN_REUSE_MERGE_QUEUE: "true",
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /merge queue passed this tree/u);
		const outputs = Object.fromEntries(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => {
					const at = line.indexOf("=");
					return [line.slice(0, at), line.slice(at + 1)];
				}),
		);
		assert.deepEqual(outputs, EMPTY_PLAN_OUTPUTS);
		assert.equal(outputs.shards, "[]");
	});
});
