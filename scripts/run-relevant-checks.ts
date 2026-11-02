import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

import { isCommit, reachRemedy } from "./lib/base-ref.ts";
import {
	type CommandInvocation,
	commandForPlatform,
	withoutPackageManager,
} from "./lib/env.ts";
import { type JsonValue, runtimeKind } from "./lib/inspectable.ts";
import { type Check, selectRelevantChecks } from "./relevant-check-policy.js";

const args = new Set(process.argv.slice(2));
const baseArg = process.argv.find((arg) => arg.startsWith("--base="));
const base =
	baseArg?.slice("--base=".length) ?? process.env.HOBO_CHECK_BASE ?? "HEAD~1";
const staged = args.has("--staged");
const all = args.has("--all");
const explain = args.has("--explain");
const includeBuild = args.has("--build");
const finalValidation = args.has("--final");
const parallelLimit = Math.max(
	1,
	Number.parseInt(process.env.HOBO_RELEVANT_CHECK_CONCURRENCY ?? "4", 10) || 4,
);

type ChangedFileRecord = {
	path: string;
	status: string;
};

/**
 * How a check is actually started: pnpm-shaped checks run through
 * scripts/run-script.mts or `node_modules/.bin` (see `withoutPackageManager`),
 * so root-script gates need no usable pnpm; what still needs pnpm (turbo's
 * package-test lanes, installs) stays pnpm. A check that cannot be started that
 * way is reported and fails.
 */
function invocationFor(
	command: string,
	commandArgs: string[],
): CommandInvocation | undefined {
	let direct: CommandInvocation;
	try {
		direct = withoutPackageManager(command, commandArgs);
	} catch (cause) {
		cannotStart(command, commandArgs, reason(cause));
		return undefined;
	}
	const shown = direct.command === process.execPath ? "node" : direct.command;
	console.log(`\n▶ ${[shown, ...direct.args].join(" ")}`);
	return commandForPlatform(direct.command, direct.args);
}

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function cannotStart(command: string, commandArgs: string[], why: string) {
	console.error(`fail  ${[command, ...commandArgs].join(" ")} — ${why}`);
}

function logCheckExit(
	check: { command: string; args: string[] },
	status: number,
): void {
	const label = `${check.command} ${check.args.join(" ")}`;
	if (status === 0) console.log(`ok  ${label} (exit 0)`);
	else console.error(`fail  ${label} (exit ${status})`);
}

function run(command: string, commandArgs: string[], check?: Check) {
	const platformCommand = invocationFor(command, commandArgs);
	if (platformCommand === undefined) return 1;
	const result = spawnSync(platformCommand.command, platformCommand.args, {
		stdio: "inherit",
		shell: false,
	});
	if (result.error) {
		cannotStart(
			command,
			commandArgs,
			`could not start ${platformCommand.command}: ${result.error.message}`,
		);
	}
	const status = result.status ?? 1;
	logCheckExit(check ?? { command, args: commandArgs }, status);
	return status;
}

function runAsync(check: Check): Promise<number> {
	const platformCommand = invocationFor(check.command, check.args);
	if (platformCommand === undefined) return Promise.resolve(1);
	const child = spawn(platformCommand.command, platformCommand.args, {
		stdio: "inherit",
		shell: false,
	});

	return new Promise<number>((resolve) => {
		child.once("error", (error) => {
			cannotStart(
				check.command,
				check.args,
				`could not start ${platformCommand.command}: ${error.message}`,
			);
			resolve(1);
		});
		child.once("exit", (status) => {
			const code = status ?? 1;
			logCheckExit(check, code);
			resolve(code);
		});
	});
}

function broadSweepScript(check: Check): string | undefined {
	if (check.command !== "pnpm" || check.args[0] !== "run") return undefined;
	const script = check.args[1];
	const broad = new Set([
		"check:all",
		"test:all",
		"test:contract",
		"test:contract:consumer",
		"test:contract:provider",
		"test:unit",
		"test:unit:quiet",
		"validate:final",
	]);
	return script !== undefined && broad.has(script) ? script : undefined;
}

function assertNoImplicitBroadSweeps(checks: Check[]) {
	if (all || finalValidation) return;

	const broadChecks = checks
		.map((check) => ({ check, script: broadSweepScript(check) }))
		.filter((entry): entry is { check: Check; script: string } =>
			Boolean(entry.script),
		);

	if (broadChecks.length === 0) return;

	console.error(
		"Relevant-check policy selected broad root sweep(s) without --final or --all:",
	);
	for (const { check, script } of broadChecks) {
		console.error(`- pnpm run ${script}: ${check.reason}`);
	}
	console.error(
		"Use changed-scope, workspace-prefix, or root-only checks while iterating.",
	);
	process.exit(1);
}

async function runBounded(
	checks: Check[],
	concurrency: number,
): Promise<number[]> {
	const statuses = Array.from({ length: checks.length }, () => 1);
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < checks.length) {
			const index = nextIndex;
			nextIndex += 1;
			statuses[index] = await runAsync(checks[index]!);
		}
	}

	const workerCount = Math.min(concurrency, checks.length);
	await Promise.all(Array.from({ length: workerCount }, worker));
	return statuses;
}

/** The command's output, or `undefined` when it failed. */
function tryCapture(
	command: string,
	commandArgs: string[],
): string | undefined {
	const platformCommand = commandForPlatform(command, commandArgs);
	const result = spawnSync(platformCommand.command, platformCommand.args, {
		encoding: "utf8",
		shell: false,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

/** For probes whose failure has a meaning of its own (no merge base, no file). */
function capture(command: string, commandArgs: string[]) {
	return tryCapture(command, commandArgs) ?? "";
}

/**
 * The listing every gate is chosen from. A git failure here (an unknown or
 * unfetched base, a depth-1 clone's HEAD~1, no repository) used to read as an
 * empty list, so agent:check printed "ok" having selected nothing. It is an
 * error instead.
 */
function changedListing(commandArgs: string[]): string {
	const listed = tryCapture("git", commandArgs);
	if (listed !== undefined) return listed;
	console.error(
		all
			? "fail  agent:check — git could not list the tracked files, so no check was selected."
			: staged
				? "fail  agent:check — git could not list the staged files, so no check was selected."
				: `fail  agent:check — git could not diff against ${base}, so no check was selected. ${reachRemedy(base)}`,
	);
	process.exit(2);
}

function parseChangedFileRecords(raw: string): ChangedFileRecord[] {
	return raw
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const [status, firstPath, secondPath] = line.split("\t");
			return { status, path: secondPath ?? firstPath };
		})
		.filter((record): record is ChangedFileRecord => Boolean(record.path));
}

function changedFileRecords(): ChangedFileRecord[] {
	if (all) {
		return changedListing(["ls-files"])
			.split(/\r?\n/)
			.filter(Boolean)
			.map((file) => ({ status: "M", path: file }));
	}
	if (staged) {
		return parseChangedFileRecords(
			changedListing([
				"diff",
				"--cached",
				"--name-status",
				"--find-renames=100%",
				"--diff-filter=ACMR",
			]),
		);
	}
	return parseChangedFileRecords(
		changedListing([
			"diff",
			"--name-status",
			"--find-renames=100%",
			"--diff-filter=ACMR",
			diffBase,
			"HEAD",
		]),
	);
}

function workspaceTestFiles(records: ChangedFileRecord[]) {
	return records
		.filter((record) => record.status !== "R100")
		.map((record) => record.path);
}

function stableJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && runtimeKind(value) === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function rootPackageJsonScriptsOnlyChanged() {
	if (all) return false;
	// Compare against index (staged) or HEAD when unstaged — scripts-only edits
	// should not be treated like dependency/task-graph changes.
	const beforeRaw = staged
		? capture("git", ["show", "HEAD:package.json"])
		: capture("git", ["show", `${diffBase}:package.json`]);
	if (!beforeRaw || !fs.existsSync("package.json")) return false;

	try {
		// SAFETY: package.json is committed repo JSON; scripts key is compared by stableJson.
		const before = JSON.parse(beforeRaw) as { scripts?: JsonValue };
		// SAFETY: working-tree package.json is the same manifest family as HEAD.
		const after = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
			scripts?: JsonValue;
		};
		delete before.scripts;
		delete after.scripts;
		return stableJson(before) === stableJson(after);
	} catch {
		return false;
	}
}

// The gates are handed this base in staged mode too, where nothing else diffs
// against it, so a named one has to be a commit before anything is chosen.
// (Otherwise the diff below refuses a base it cannot reach.)
if (staged && baseArg !== undefined && !isCommit(base)) {
	console.error(
		`fail  agent:check — --base=${base} is not a commit here, so no check was selected. ${reachRemedy(base)}`,
	);
	process.exit(2);
}
const diffBase = capture("git", ["merge-base", base, "HEAD"]) || base;
const records = changedFileRecords();
const files = records.map((record) => record.path);
if (files.length === 0) {
	console.log("No changed files; skipping relevant checks.");
	console.log("ok  agent:check — nothing to validate for this scope.");
	process.exit(0);
}

const { checks, scopes } = selectRelevantChecks({
	files,
	base,
	workspaceTestFiles: workspaceTestFiles(records),
	staged,
	all,
	includeBuild,
	includeBroadSweeps: all || finalValidation,
	rootPackageJsonScriptsOnlyChanged: rootPackageJsonScriptsOnlyChanged(),
});

console.log(`Changed files: ${files.length}`);
console.log(`Detected scope: ${scopes.join(", ") || "standard"}`);
for (const check of checks)
	console.log(`- ${check.command} ${check.args.join(" ")} (${check.reason})`);

assertNoImplicitBroadSweeps(checks);

if (explain) process.exit(0);

for (const check of checks.filter((check) => check.serial)) {
	const status = run(check.command, check.args, check);
	if (status !== 0) process.exit(status);
}

const parallelChecks = checks.filter((check) => !check.serial);
if (parallelChecks.length > 0) {
	console.log(
		`Running ${parallelChecks.length} parallel-capable check(s) with concurrency ${parallelLimit}.`,
	);
}
const statuses = await runBounded(parallelChecks, parallelLimit);
const failed = statuses.find((status) => status !== 0);
if (failed) process.exit(failed);

console.log(
	`\nok  agent:check — ${checks.length} relevant check(s) passed` +
		(staged ? " (staged scope)" : ""),
);
process.exit(0);
