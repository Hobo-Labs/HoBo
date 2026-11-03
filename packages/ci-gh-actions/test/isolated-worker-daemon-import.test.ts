import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

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

	it("refuses to start, and says why, when it cannot build what it imports", () => {
		const empty = mkdtempSync(join(tmpdir(), "hobo-worker-path-"));
		onTestFinished(() => rmSync(empty, { recursive: true, force: true }));
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", daemon],
			{
				cwd: repoRoot,
				encoding: "utf8",
				// No pnpm on PATH, and not inside a turbo task.
				env: { PATH: empty, HOME: empty, NODE_OPTIONS: "" },
			},
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(
			/hobo_ci_isolated_worker_start_failed.*cannot build @hobo\/ci-gh-actions.*put pnpm on PATH/u,
		);
		expect(result.stderr).not.toMatch(/missing HOBO_CI_GITHUB_APP_ID/u);
	});
});
