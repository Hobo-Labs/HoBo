#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv: string[]) {
	const labelIdx = argv.indexOf("--label");
	if (labelIdx < 0 || !argv[labelIdx + 1]) {
		throw new Error(
			"usage: run-job-command-report.mts --label <name> -- <command> [args...]",
		);
	}
	const dash = argv.indexOf("--");
	if (dash < 0 || dash >= argv.length - 1) {
		throw new Error(
			"usage: run-job-command-report.mts --label <name> -- <command> [args...]",
		);
	}
	return {
		label: argv[labelIdx + 1]!,
		command: argv[dash + 1]!,
		commandArgs: argv.slice(dash + 2),
	};
}

function main(): void {
	const { label, command, commandArgs } = parseArgs(process.argv.slice(2));
	const logDir = process.env.HOBO_CI_JOB_LOG_DIR ?? "/tmp/hobo-ci-job-logs";
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `${label}.log`);
	const result = spawnSync(command, commandArgs, {
		cwd: join(import.meta.dirname, "..", ".."),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: process.env,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	writeFileSync(logPath, output, "utf8");
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		const lines = [`## ${label}`, "", `Log: \`${logPath}\``, ""];
		if (result.status === 0) {
			lines.push("**passed**", "");
		} else {
			const tail = output.split("\n").slice(-200).join("\n");
			lines.push("```", tail, "```", "");
		}
		appendFileSync(summaryPath, `${lines.join("\n")}\n`);
	}
	if (process.env.GITHUB_ENV) {
		appendFileSync(
			process.env.GITHUB_ENV,
			`HOBO_CI_JOB_LOG_PATH=${logPath}\nHOBO_CI_JOB_LOG_DIR=${logDir}\n`,
		);
	}
	process.exit(result.status ?? 1);
}

main();
