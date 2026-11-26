import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-site-nav", () => {
	it("exits 0 and reports zero missing nav pages against real site/src/nav.ts", () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", join(root, "scripts/check-site-nav.mts")],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /missing-count: 0/);
		assert.match(result.stdout, /slug-count: \d+/);
		const count = Number(result.stdout.match(/slug-count: (\d+)/)?.[1]);
		assert.ok(count >= 90, `expected many nav leaves, got ${count}`);
	});
});
