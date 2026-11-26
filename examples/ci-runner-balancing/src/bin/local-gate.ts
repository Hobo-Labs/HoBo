/**
 * CLI shell for the local gate (Turborepo-style CI deferral).
 *
 *   node --import tsx src/bin/local-gate.ts [--base origin/main]
 *
 * Runs the same command suite as the hosted pr-gate job on THIS machine,
 * streams output, and writes the folded evidence (JSON + markdown) to
 * stdout and, when set, HOBO_RB_STATE_DIR. Exit code is 0 only when every
 * gate passed — usable as a pre-push verification and as the CI verdict
 * of last resort when no runner (hosted or self-hosted) can be had.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import process from "node:process";

import { changedDirs, foldGateReport, gateSuite } from "../gate.js";

function git(...args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

function main(): void {
	let base = "origin/main";
	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index + 1];
		if (argv[index] === "--base" && value !== undefined) {
			base = value;
			index += 1;
		}
	}

	const headSha = git("rev-parse", "HEAD") || "(unknown)";
	const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n");
	const suite = gateSuite({
		base,
		changedPackageDirs: changedDirs(changed, "packages"),
		changedExampleDirs: changedDirs(changed, "examples"),
	});

	const results = suite.map((gate) => {
		console.log(`\n=== local-gate: ${gate.id} — ${gate.command} ${gate.args.join(" ")} ===`);
		const started = Date.now();
		const child = spawnSync(gate.command, [...gate.args], {
			stdio: "inherit",
			env: process.env,
		});
		return {
			id: gate.id,
			command: `${gate.command} ${gate.args.join(" ")}`,
			exitCode: child.status ?? 1,
			durationMs: Date.now() - started,
		};
	});

	const report = foldGateReport({
		headSha,
		base,
		seq: new Date().toISOString(),
		host: hostname(),
		results,
	});

	console.log(`\n${report.markdown}\n`);
	const stateDir = process.env.HOBO_RB_STATE_DIR;
	if (stateDir !== undefined && stateDir !== "") {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			path.join(stateDir, "local-gate.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
		writeFileSync(path.join(stateDir, "local-gate.md"), `${report.markdown}\n`);
	}
	process.exitCode = report.passed ? 0 : 1;
}

main();
