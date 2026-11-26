/**
 * The pin tests build git repositories and caches under the temp directory.
 * A run that leaves them behind costs disk on a machine that has very little,
 * so what `scratch()` hands out is removed when the process ends, and what an
 * earlier run (a killed one) left is swept the next time.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO_ROOT } from "./support/pins-support.ts";

const PROBE = join(REPO_ROOT, "scripts/test/support/scratch-probe.mts");

function probe(): string {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", PROBE],
		{ encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

describe("scratch directories", () => {
	it("are removed when the process that made them exits", () => {
		const dir = probe();
		assert.match(dir, /pins-probe-/u);
		assert.equal(existsSync(dir), false, `${dir} was left behind`);
	});

	it("an old one from an earlier run is swept, a young one and a stranger are not", () => {
		const old = join(tmpdir(), "pins-leaked-AbCd12");
		const young = join(tmpdir(), "pins-running-ZyXw98");
		const stranger = join(tmpdir(), "pins-keep-me-not-ours");
		for (const dir of [old, young, stranger])
			mkdirSync(dir, { recursive: true });
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(old, hourAgo, hourAgo);
		utimesSync(stranger, hourAgo, hourAgo);
		try {
			probe();
			assert.equal(
				existsSync(old),
				false,
				"the old scratch directory is swept",
			);
			assert.equal(
				existsSync(young),
				true,
				"a young one may belong to a live run",
			);
			assert.equal(
				existsSync(stranger),
				true,
				"only names scratch() makes are touched",
			);
		} finally {
			for (const dir of [old, young, stranger])
				rmSync(dir, { recursive: true, force: true });
		}
	});
});
