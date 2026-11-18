import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("release state is internally consistent", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", join(root, "scripts/check-release-state.mts")],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /release-state: OK/u);
});
