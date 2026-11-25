import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

test("frozen promoted proofs match the promotions ledger", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/check-promoted-proof-drift.mts"],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, NODE_OPTIONS: "" },
		},
	);
	assert.equal(
		result.status,
		0,
		`promoted-proof drift guard failed:\n${result.stdout}${result.stderr}`,
	);
});
