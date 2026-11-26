#!/usr/bin/env node
/**
 * Root `pnpm hobo …` entrypoint.
 *
 * Every doc used to say `pnpm --filter @hobo/hobo exec hobo …`, which can
 * never work: pnpm does not link a package's own bin into its own
 * node_modules/.bin, so `hobo` is not resolvable there. This wrapper is the
 * supported invocation. It also self-heals the two fresh-clone traps:
 *
 *   - packages/hobo has no dist/ yet → build it (and @hobo/adapter-hono,
 *     which the flagship examples import) once, then run.
 *   - external/ts-autocode submodule missing → say exactly how to fix it
 *     instead of failing with a cryptic TS2307 mid-build.
 *
 * Usage: pnpm hobo <verb> [...args]   e.g. pnpm hobo dev --cwd examples/hello-bindle
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const HOBO_BIN = path.join(REPO_ROOT, "packages/hobo/dist/bin/hobo.js");
const SUBMODULE_MARKER = path.join(
	REPO_ROOT,
	"external/ts-autocode/package.json",
);

if (!existsSync(SUBMODULE_MARKER)) {
	console.error(
		"external/ts-autocode submodule is missing (workspace package ts-autocode-grounding cannot resolve).\n" +
			"Fix: pnpm run pins:fetch ts-autocode && pnpm install",
	);
	process.exit(1);
}

if (!existsSync(HOBO_BIN)) {
	console.error("hobo CLI not built yet — building @hobo/hobo (one-time)…");
	// Prefer the installed turbo binary directly: this script already runs
	// under `node --import tsx`, so node_modules exists. Going through
	// `pnpm exec` would need a `pnpm` shim on PATH, which a corepack-only
	// setup (no writable Node bin dir for `corepack enable`) does not have.
	const turboBin = path.join(
		REPO_ROOT,
		"node_modules",
		".bin",
		process.platform === "win32" ? "turbo.cmd" : "turbo",
	);
	const turboArgs = [
		"run",
		"build",
		"--filter",
		"@hobo/hobo",
		"--filter",
		"@hobo/adapter-hono",
		"--concurrency=100%",
	];
	if (existsSync(turboBin)) {
		execFileSync(turboBin, turboArgs, { cwd: REPO_ROOT, stdio: "inherit" });
	} else {
		execFileSync("pnpm", ["exec", "turbo", ...turboArgs], {
			cwd: REPO_ROOT,
			stdio: "inherit",
		});
	}
	if (!existsSync(HOBO_BIN)) {
		console.error(`build finished but ${HOBO_BIN} is still missing`);
		process.exit(1);
	}
}

const result = spawnSync(
	process.execPath,
	[HOBO_BIN, ...process.argv.slice(2)],
	{
		cwd: process.cwd(),
		stdio: "inherit",
	},
);
process.exit(result.status ?? 1);
