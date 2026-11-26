/**
 * Local gate: Turborepo-style deferral of CI work to the requesting
 * machine. When GitHub cannot schedule any runner (and even the
 * last-resort ephemeral runner cannot be registered — e.g. sandboxed
 * agent sessions whose egress proxy forbids the Actions API), the
 * requesting machine runs the same command suite the pr-gate job runs
 * and publishes the folded evidence. The commands are the verification;
 * the hosted lane becomes a replay/attestation of work the requester
 * already did — the same inversion Turborepo remote caching applies to
 * builds.
 *
 * Pure helpers only in this module (suite construction + report folding);
 * the spawn/git shell lives in src/bin/local-gate.ts.
 */

import type { JsonObject } from "./parse.js";

export interface GateCommand {
	/** Stable identifier, e.g. "agent-check". */
	id: string;
	command: string;
	args: readonly string[];
}

/**
 * Mirror of .github/workflows/hobo-ci.yml pr-gate: relevant checks against
 * the base ref, affected package/example lanes via Turbo, and the
 * production-packages build gate.
 */
export function gateSuite(options: {
	base: string;
	changedPackageDirs: readonly string[];
	changedExampleDirs: readonly string[];
}): GateCommand[] {
	const suite: GateCommand[] = [
		{
			id: "agent-check",
			command: "pnpm",
			args: ["run", "agent:check", "--", `--base=${options.base}`],
		},
	];
	const filters = [
		...options.changedPackageDirs.map((dir) => `--filter=./packages/${dir}`),
		...options.changedExampleDirs.map((dir) => `--filter=./examples/${dir}`),
	];
	if (filters.length > 0) {
		suite.push({
			id: "turbo-affected",
			command: "pnpm",
			args: [
				"exec",
				"turbo",
				"run",
				"build",
				"typecheck",
				"lint",
				"test:unit",
				"test:schema",
				"test:contract:consumer",
				...filters,
				"--continue=never",
			],
		});
	}
	suite.push({
		id: "build-packages",
		command: "pnpm",
		args: ["run", "build:packages"],
	});
	return suite;
}

/** Derive changed package/example dirs from a git name-only diff. */
export function changedDirs(
	files: readonly string[],
	parent: "packages" | "examples",
): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		const match = file.match(new RegExp(`^${parent}/([^/]+)/`));
		const dir = match?.[1];
		if (dir !== undefined) dirs.add(dir);
	}
	return [...dirs].sort();
}

export interface GateCommandResult {
	id: string;
	command: string;
	exitCode: number;
	durationMs: number;
}

export interface GateReport {
	passed: boolean;
	headSha: string;
	base: string;
	seq: string;
	host: string;
	results: readonly GateCommandResult[];
	/** golden.Ran per command, golden.Passed only when everything exited 0. */
	events: ReadonlyArray<{ family: string; payload: JsonObject }>;
	markdown: string;
}

export function foldGateReport(options: {
	headSha: string;
	base: string;
	seq: string;
	host: string;
	results: readonly GateCommandResult[];
}): GateReport {
	const passed =
		options.results.length > 0 &&
		options.results.every((result) => result.exitCode === 0);
	const events: Array<{ family: string; payload: JsonObject }> =
		options.results.map((result) => ({
			family: "golden.Ran",
			payload: {
				gate: result.id,
				command: result.command,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				headSha: options.headSha,
				seq: options.seq,
			},
		}));
	if (passed) {
		events.push({
			family: "golden.Passed",
			payload: {
				headSha: options.headSha,
				base: options.base,
				seq: options.seq,
				gates: options.results.length,
			},
		});
	}
	const rows = options.results
		.map(
			(result) =>
				`| \`${result.id}\` | \`${result.command}\` | ${
					result.exitCode === 0 ? "✅ 0" : `❌ ${result.exitCode}`
				} | ${(result.durationMs / 1000).toFixed(1)}s |`,
		)
		.join("\n");
	const markdown = [
		`### Local gate ${passed ? "PASSED" : "FAILED"} on requesting machine \`${options.host}\``,
		"",
		`Head \`${options.headSha}\` vs \`${options.base}\` @ \`${options.seq}\` — same suite as the hosted pr-gate job.`,
		"",
		"| Gate | Command | Exit | Duration |",
		"|---|---|---|---|",
		rows,
	].join("\n");
	return {
		passed,
		headSha: options.headSha,
		base: options.base,
		seq: options.seq,
		host: options.host,
		results: options.results,
		events,
		markdown,
	};
}
