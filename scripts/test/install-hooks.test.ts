import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const installer = join(root, "scripts/install-hooks.mts");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const inherited = new Set([
	"CI",
	"HOBO_SKIP_HOOKS",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"NODE_OPTIONS",
]);
const env = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !inherited.has(name)),
	),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

/** A repository with a .githooks directory, as the root `prepare` sees it. */
function checkout(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-install-hooks-"));
	scratch.push(dir);
	assert.equal(
		spawnSync("git", ["init", "--quiet"], { cwd: dir, env }).status,
		0,
	);
	mkdirSync(join(dir, ".githooks"));
	return dir;
}

function install(cwd: string, extra: Record<string, string>) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", installer],
		{ cwd, encoding: "utf8", env: { ...env, ...extra } },
	);
}

function hooksPath(repo: string): string {
	return spawnSync("git", ["config", "--get", "core.hooksPath"], {
		cwd: repo,
		encoding: "utf8",
		env,
	}).stdout.trim();
}

// `prepare` and the session-start script read the same two opt-outs, as
// booleans: any non-empty value used to skip, so CI=false and
// HOBO_SKIP_HOOKS=0 left a checkout with no commit hook.
describe("scripts/install-hooks.mts opt-outs", () => {
	it("skips for HOBO_SKIP_HOOKS or CI set to 1, true, yes or on", () => {
		for (const optOut of [
			{ HOBO_SKIP_HOOKS: "1" },
			{ HOBO_SKIP_HOOKS: "on" },
			{ CI: "true" },
			{ CI: "YES" },
		]) {
			const repo = checkout();
			const result = install(repo, optOut);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /skipped/u);
			assert.equal(hooksPath(repo), "", JSON.stringify(optOut));
		}
	});

	it("installs when they are 0, false or empty", () => {
		for (const value of [
			{ HOBO_SKIP_HOOKS: "0" },
			{ HOBO_SKIP_HOOKS: "" },
			{ CI: "false" },
			{ CI: "0" },
		]) {
			const repo = checkout();
			const result = install(repo, value);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(hooksPath(repo), ".githooks", JSON.stringify(value));
		}
	});
});
