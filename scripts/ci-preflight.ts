#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const checks: Array<["ok" | "fail", string]> = [];
const fail = (message: string) => checks.push(["fail", message]);
const ok = (message: string) => checks.push(["ok", message]);

type RunOptions = { stdio?: "inherit" | "pipe" };

const run = (command: string, args: string[], options: RunOptions = {}) => {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: options.stdio ?? "pipe",
	});
	return result;
};

if (existsSync(join(root, "package.json"))) ok("package.json present");
else fail("package.json missing; run from repo root");

if (existsSync(join(root, "pnpm-lock.yaml"))) ok("pnpm-lock.yaml present");
else fail("pnpm-lock.yaml missing; CI pnpm cache/install cannot be reproduced");

const workflowDir = join(root, ".github", "workflows");
if (
	existsSync(workflowDir) &&
	readdirSync(workflowDir).some((name) => /\.ya?ml$/.test(name))
) {
	ok("GitHub workflow files present");
} else {
	fail(".github/workflows has no workflow YAML files");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) ok(`Node ${process.version}`);
else fail(`Node ${process.version} is below repo engine floor`);

const corepack = run("corepack", ["--version"]);
if (corepack.status === 0) ok(`Corepack ${corepack.stdout.trim()}`);
else
	fail("Corepack unavailable; enable a Node distribution that ships Corepack");

const pnpm = run("pnpm", ["--version"]);
if (pnpm.status === 0) ok(`pnpm ${pnpm.stdout.trim()}`);
else fail("pnpm unavailable; run bash scripts/bootstrap-dev.sh --project-only");

for (const [status, message] of checks) {
	console.log(`${status === "ok" ? "ok  " : "ERR "} ${message}`);
}
if (checks.some(([status]) => status === "fail")) process.exit(1);

console.log(
	"run pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
);
const install = run(
	"pnpm",
	["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"],
	{ stdio: "inherit" },
);
if (install.status !== 0) process.exit(install.status ?? 1);
