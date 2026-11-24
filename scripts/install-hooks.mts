import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function skip(reason: string): never {
	console.log(`install-hooks: skipped (${reason}).`);
	process.exit(0);
}

function on(value: string | undefined): boolean {
	return /^(?:1|true|yes|on)$/iu.test(value ?? "");
}

if (on(process.env.HOBO_SKIP_HOOKS)) skip("HOBO_SKIP_HOOKS is set");
if (on(process.env.CI)) skip("CI environment");
if (!existsSync(".git")) skip("not a git working tree");
if (!existsSync(".githooks")) skip(".githooks directory is missing");

try {
	const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
		stdio: "inherit",
	});
	if (result.status === 0) {
		console.log("install-hooks: core.hooksPath -> .githooks");
	} else {
		console.log("install-hooks: could not set core.hooksPath; skipping.");
	}

	const stackDefaults: Array<[string, string]> = [
		["rerere.enabled", "true"],
		["remote.pushDefault", "origin"],
	];
	for (const [key, value] of stackDefaults) {
		const set = spawnSync("git", ["config", key, value], { stdio: "pipe" });
		if (set.status === 0) {
			console.log(`install-hooks: ${key}=${value}`);
		}
	}
	const drivers = spawnSync("sh", ["scripts/ensure-hooks-path.sh"], {
		stdio: "pipe",
	});
	if (drivers.status === 0)
		console.log("install-hooks: merge drivers for generated pins and catalog");
} catch (error) {
	const message = error instanceof Error ? error.message : "git unavailable";
	console.log(`install-hooks: skipped (${message}).`);
}

process.exit(0);
