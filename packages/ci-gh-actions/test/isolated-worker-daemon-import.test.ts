import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "../..");
const daemon = join(packageRoot, "scripts/isolated-worker-daemon.mts");

describe("isolated-worker-daemon.mts startup imports", () => {
	it("resolves @hobo/ci-gh-actions under node --experimental-strip-types", () => {
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", daemon],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					NODE_OPTIONS: "",
				},
			},
		);
		const combined = `${result.stdout}\n${result.stderr}`;
		expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND/u);
		expect(combined).not.toMatch(/postgres-pool\.js/u);
		expect(combined).toMatch(/missing DATABASE_URL/u);
	});
});
