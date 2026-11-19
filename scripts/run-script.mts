#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function refuse(message: string): never {
	console.error(`run-script: ${message}`);
	process.exit(2);
}

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function rootScripts(): { readonly [name: string]: string } {
	const file = join(root, "package.json");
	try {
		const manifest: {
			readonly scripts?: { readonly [name: string]: string };
		} = JSON.parse(readFileSync(file, "utf8"));
		return manifest.scripts ?? {};
	} catch (cause) {
		return refuse(`cannot read ${file}: ${reason(cause)}`);
	}
}

const [name, ...rest] = process.argv.slice(2);
if (name === undefined || name.startsWith("-")) {
	refuse("usage: run-script.mts <name> [--] [args...]");
}
const scripts = rootScripts();
const script = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
if (script === undefined) refuse(`no script named ${name} in package.json`);
if (
	Object.hasOwn(scripts, `pre${name}`) ||
	Object.hasOwn(scripts, `post${name}`)
) {
	refuse(
		`${name} has a pre or post script, which only the package manager runs; use pnpm run ${name}`,
	);
}

const args = rest[0] === "--" ? rest.slice(1) : rest;
const shell = process.platform === "win32" ? "sh" : "/bin/sh";
const bin = join(root, "node_modules", ".bin");
const result = spawnSync(shell, ["-c", `${script} "$@"`, name, ...args], {
	cwd: root,
	stdio: "inherit",
	env: {
		...process.env,
		PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
	},
});
if (result.error) refuse(`could not start ${shell}: ${result.error.message}`);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
