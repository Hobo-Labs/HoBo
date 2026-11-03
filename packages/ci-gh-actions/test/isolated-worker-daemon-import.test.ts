import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "../..");
const daemon = join(packageRoot, "scripts/isolated-worker-daemon.mts");

describe("isolated-worker-daemon.mts startup imports", () => {
	function run(env: Readonly<Record<string, string>>) {
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) => !name.startsWith("HOBO_CI_") && name !== "DATABASE_URL",
			),
		);
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", daemon],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: { ...inherited, NODE_OPTIONS: "", ...env },
			},
		);
		return `${result.stdout}\n${result.stderr}`;
	}

	it("resolves @hobo/ci-gh-actions under node --experimental-strip-types", () => {
		const combined = run({});
		expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND/u);
		expect(combined).not.toMatch(/postgres-pool\.js/u);
		// SQLite is the default store, so the first missing input is the GitHub App.
		expect(combined).toMatch(/missing HOBO_CI_GITHUB_APP_ID/u);
	});

	it("still requires the named connection string when Postgres is chosen", () => {
		expect(run({ HOBO_CI_STORE: "postgres" })).toMatch(/missing DATABASE_URL/u);
	});
});
