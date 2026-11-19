#!/usr/bin/env node
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
