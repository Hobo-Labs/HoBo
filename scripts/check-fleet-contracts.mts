#!/usr/bin/env node
/**
 * `pnpm run fleet:contracts` (O26, ADR-0182): the frozen contracts did not
 * drift. Two checks, both must pass:
 *
 * 1. `scripts/emit-fleet-contracts.mts --check` (the coordinator's emitter):
 *    the declarations of every contract entry point equal each package's
 *    `contracts/api.snapshot.d.ts`;
 * 2. provenance: `git diff --exit-code <newest Fleet-Contract commit> --
 *    'packages/*\/contracts/api.snapshot.d.ts' packages/fleet/data-models`, so
 *    no snapshot or record changed outside a contract or amendment commit.
 *
 *   node --import tsx scripts/check-fleet-contracts.mts [--root=<dir>] [--no-build]
 *
 * The emitter reads workspace dependencies through their built declarations,
 * so the command first builds the contract packages with turbo (cached when
 * nothing changed); `--no-build` skips that step.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ContractsReport {
	readonly pass: boolean;
	readonly emit: Readonly<{
		command: string;
		exitCode: number;
		output: string;
	}>;
	readonly provenance: Readonly<{
		command: string;
		/** The newest commit with a `Fleet-Contract:` trailer, when there is one. */
		base: string | undefined;
		exitCode: number;
		/** Snapshot and record paths that differ from `base`. */
		changed: readonly string[];
	}>;
}

const PROTECTED = [
	"packages/*/contracts/api.snapshot.d.ts",
	"packages/fleet/data-models",
] as const;

/** One finished command: its exit code and everything it printed. */
interface CommandResult {
	readonly exitCode: number;
	readonly output: string;
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
): CommandResult {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		exitCode: result.status ?? 1,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
	};
}

/** The packages `emit-fleet-contracts.mts` reads, which must be built first. */
const CONTRACT_PACKAGES = [
	"@hobo/fleet",
	"@hobo/fleet-nats",
	"@hobo/fleet-p2p",
	"@hobo/fleet-agent",
	"@hobo/fleet-authority",
	"@hobo/identity",
	"@hobo/connectivity",
	"@hobo/ci-gh-actions",
] as const;

/** Runs both checks of O26 against the repository at `root`; `build` first builds the contract packages. */
export function checkFleetContracts(
	root: string,
	options: Readonly<{ build?: boolean }> = {},
): ContractsReport {
	if (options.build === true) {
		const built = run(
			"pnpm",
			[
				"exec",
				"turbo",
				"run",
				"build",
				...CONTRACT_PACKAGES.map((name) => `--filter=${name}`),
				"--output-logs=errors-only",
			],
			root,
		);
		if (built.exitCode !== 0)
			return {
				pass: false,
				emit: {
					command: "pnpm exec turbo run build (the contract packages)",
					...built,
				},
				provenance: {
					command: "not run: the contract packages did not build",
					base: undefined,
					exitCode: 1,
					changed: [],
				},
			};
	}
	const tsx = import.meta.resolve("tsx");
	const emitted = run(
		process.execPath,
		[
			"--import",
			tsx,
			join(root, "scripts/emit-fleet-contracts.mts"),
			"--check",
		],
		root,
	);
	const emit = {
		command: "node --import tsx scripts/emit-fleet-contracts.mts --check",
		...emitted,
	};

	const log = run(
		"git",
		["log", "-1", "--format=%H", "--grep=^Fleet-Contract: "],
		root,
	);
	const base =
		log.exitCode === 0 && log.output.trim() !== ""
			? log.output.trim()
			: undefined;
	const command = `git diff --exit-code "$(git log -1 --format=%H --grep='^Fleet-Contract: ')" -- ${PROTECTED.map((path) => `'${path}'`).join(" ")}`;
	if (base === undefined)
		return {
			pass: false,
			emit,
			provenance: { command, base, exitCode: 1, changed: [] },
		};
	const diff = run(
		"git",
		["diff", "--exit-code", "--name-only", base, "--", ...PROTECTED],
		root,
	);
	const changed = diff.output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("fatal:"));
	return {
		pass: emit.exitCode === 0 && diff.exitCode === 0,
		emit,
		provenance: { command, base, exitCode: diff.exitCode, changed },
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const rootArg = process.argv
		.slice(2)
		.find((arg) => arg.startsWith("--root="))
		?.slice("--root=".length);
	const root = rootArg
		? resolve(rootArg)
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const report = checkFleetContracts(root, {
		build: !process.argv.includes("--no-build"),
	});
	if (report.emit.exitCode !== 0)
		process.stderr.write(
			`fleet:contracts: ${report.emit.command} failed:\n${report.emit.output}\n`,
		);
	if (report.provenance.base === undefined)
		process.stderr.write(
			"fleet:contracts: no commit carries a `Fleet-Contract:` trailer\n",
		);
	else if (report.provenance.exitCode !== 0)
		process.stderr.write(
			[
				`fleet:contracts: changed since ${report.provenance.base} outside a Fleet-Contract commit:`,
				...report.provenance.changed.map((path) => `- ${path}`),
				"",
			].join("\n"),
		);
	if (!report.pass) process.exit(1);
	process.stdout.write(
		`fleet:contracts: snapshots match and unchanged since ${report.provenance.base}\n`,
	);
}
