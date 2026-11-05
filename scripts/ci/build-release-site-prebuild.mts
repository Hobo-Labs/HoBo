#!/usr/bin/env node
/** Turbo build for release Pages: ts-autocode-grounding before hobo-site prebuild. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveReleaseTurboBase } from "./stage-release-oci-app.mts";

const root = join(import.meta.dirname, "..", "..");

export function releaseSitePrebuildTurboArgs(
	cwd = root,
	configuredBase = process.env.HOBO_RELEASE_TURBO_BASE,
): string[] {
	const base = resolveReleaseTurboBase(cwd, configuredBase);
	if (base) {
		const diff = spawnSync("git", ["diff", "--quiet", base, "HEAD"], {
			cwd,
			stdio: "ignore",
		});
		if (diff.status !== 0) {
			return [
				"exec",
				"turbo",
				"run",
				"build",
				`--filter=ts-autocode-grounding...[${base}...HEAD]`,
			];
		}
	}
	return ["exec", "turbo", "run", "build", "--filter=ts-autocode-grounding..."];
}

function main(): void {
	const args = releaseSitePrebuildTurboArgs();
	const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
