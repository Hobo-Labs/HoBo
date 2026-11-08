#!/usr/bin/env node
/**
 * Cold-clone DX preflight: clear install-first messaging before tsx stacks.
 * Runs under `node --experimental-strip-types` (no node_modules required).
 *
 * Usage:
 *   node --experimental-strip-types scripts/dx-preflight.mts doctor [-- args…]
 *   node --experimental-strip-types scripts/dx-preflight.mts agent:check [-- args…]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

const verb = process.argv[2] ?? "";
// pnpm often injects a lone "--" before user args; drop empties/separators
const passthrough = process.argv.slice(3).filter((a) => a !== "--" && a !== "");

function failInstall(reason: string): never {
	console.error(`fail  ${reason}`);
	console.error(
		"next  bash scripts/bootstrap-dev.sh --project-only && pnpm run install:check",
	);
	console.error(
		"hint  Workspace scripts need local deps (tsx). Install once, then re-run.",
	);
	process.exit(1);
}

function hasNodeModules(): boolean {
	return existsSync(path.join(root, "node_modules"));
}

function resolveTsx(): string | null {
	try {
		return require.resolve("tsx");
	} catch {
		return null;
	}
}

function runNode(loaderArgs: string[], script: string, args: string[]): number {
	const result = spawnSync(process.execPath, [...loaderArgs, script, ...args], {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		console.error(`fail  could not spawn node: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

function runWithTsxOrStrip(scriptRel: string, args: string[]): number {
	const script = path.join(root, scriptRel);
	const tsx = resolveTsx();
	if (tsx) {
		return runNode(["--import", "tsx"], script, args);
	}
	// Cold path: strip-types only works for scripts that do not need package deps.
	return runNode(["--experimental-strip-types"], script, args);
}

if (verb === "doctor") {
	// Doctor itself is node-builtin-only and should run without install.
	// Still report missing node_modules so cold clones get an install path.
	const code = runNode(
		["--experimental-strip-types"],
		path.join(root, "scripts/doctor.ts"),
		passthrough,
	);
	process.exit(code);
}

if (verb === "agent:check" || verb === "check") {
	if (!hasNodeModules()) {
		failInstall("node_modules missing — cannot run agent:check");
	}
	if (!resolveTsx()) {
		failInstall("package 'tsx' not found under node_modules");
	}
	const code = runWithTsxOrStrip("scripts/run-relevant-checks.ts", passthrough);
	process.exit(code);
}

console.error("usage: dx-preflight.mts <doctor|agent:check> [-- script-args…]");
process.exit(2);
