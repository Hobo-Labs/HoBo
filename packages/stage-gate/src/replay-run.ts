/**
 * Which run a report belongs to (ADR-0172): the report `ai-bdd run` leaves on
 * disk is read only once it is shown to be the one this run wrote. An old one
 * survives exit 2 and 4, a moved runsDir, a wrapper that swallows ai-bdd's
 * failure, and a CLI that never loaded.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { type AcceptanceEvidence, parseAiBddRunReport } from "./acceptance.js";
import type { AcceptanceConfig } from "./acceptance-config.js";

export type ReportRead =
	| { readonly bytes: Buffer; readonly evidence: AcceptanceEvidence }
	| { readonly refused: string };

export function readReport(config: AcceptanceConfig): ReportRead {
	let bytes: Buffer;
	try {
		bytes = readFileSync(config.reportFile);
	} catch {
		return { refused: `${shown(config, config.reportFile)} is missing` };
	}
	try {
		return { bytes, evidence: parseAiBddRunReport(bytes) };
	} catch (cause) {
		return { refused: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** A path as a person reads it in a message: relative to the project when inside it. */
export function shown(config: AcceptanceConfig, path: string): string {
	const rel = relative(config.project, path);
	return rel === "" || rel.startsWith("..") ? path : rel.split(sep).join("/");
}

/** The run directories that exist now; none when the runs directory does not. */
export function runIds(config: AcceptanceConfig): ReadonlySet<string> {
	try {
		return new Set(readdirSync(config.runsDir));
	} catch {
		return new Set();
	}
}

/**
 * Allowed difference between this machine's clock and the one that stamped
 * `startedAt`. Past it the check fails closed: a fresh run on a clock more than
 * this far behind is refused, not recorded `not_run`.
 */
const CLOCK_SKEW_MS = 5000;

/**
 * Why `runsDir/<runId>`, when it exists, is not a run directory ai-bdd made;
 * undefined when it is one or is absent. ai-bdd makes a new directory for
 * each run (and refuses one that resolves outside runsDir), so a link is not
 * its run, and the gate follows none.
 */
export function runDirectoryProblem(
	config: AcceptanceConfig,
	runId: string,
): string | undefined {
	const runDir = join(config.runsDir, runId);
	const entry = lstatSync(runDir, { throwIfNoEntry: false });
	if (entry === undefined || entry.isDirectory()) return undefined;
	return entry.isSymbolicLink()
		? `${shown(config, runDir)} is a symbolic link, not the directory ai-bdd creates`
		: `${shown(config, runDir)} is not a directory`;
}

/** A path with its symbolic links resolved, or as given when it does not exist. */
function realOf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Whether the report on disk is the one the run just spawned wrote: its run
 * directory is new, it started no earlier than the spawn (less skew), and it
 * is the run this ai-bdd named in its `Run: <dir>` line. An old report
 * survives exit 2 and 4, a moved runsDir, a wrapper that swallows ai-bdd's
 * failure, and a CLI that never loaded; another `ai-bdd run` in the same
 * project can write the latest report after this one. None of those is this
 * run.
 */
export function staleBecause(
	config: AcceptanceConfig,
	evidence: AcceptanceEvidence,
	before: ReadonlySet<string>,
	spawnedAt: number,
	printedRunDir: string | undefined,
): string | undefined {
	const runs = shown(config, config.runsDir);
	const stale = "it is not this run's report";
	if (before.has(evidence.runId)) {
		return `report.json names run ${evidence.runId}, which was already in ${runs} before this run started: ${stale}`;
	}
	if (!runIds(config).has(evidence.runId)) {
		return `report.json names run ${evidence.runId}, which ${runs} does not hold: ${stale}`;
	}
	const problem = runDirectoryProblem(config, evidence.runId);
	if (problem !== undefined) {
		return `report.json names run ${evidence.runId}, but ${problem}: ${stale}`;
	}
	if (Date.parse(evidence.startedAt) < spawnedAt - CLOCK_SKEW_MS) {
		const spawned = new Date(spawnedAt).toISOString();
		return `report.json for run ${evidence.runId} started at ${evidence.startedAt}, before this run was started at ${spawned} (5 s of clock skew allowed): ${stale}`;
	}
	if (printedRunDir === undefined) {
		return `report.json names run ${evidence.runId}, but this ai-bdd printed no "Run: <dir>" line to tie it to this run`;
	}
	const printed = realOf(resolve(config.project, printedRunDir));
	if (printed !== realOf(join(config.runsDir, evidence.runId))) {
		return `report.json names run ${evidence.runId}, but this ai-bdd printed "Run: ${printedRunDir}": ${stale}`;
	}
	return undefined;
}
