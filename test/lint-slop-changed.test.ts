/**
 * anti-slop changed-file lane: empty diffs skip oxlint so the pre-existing
 * repo-wide backlog cannot block commits that touch no lintable files.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

test("lint:slop:changed exits 0 when the base diff has no lintable files", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/lint-slop-changed.mts", "--base=HEAD"],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no changed lintable files/u);
});
