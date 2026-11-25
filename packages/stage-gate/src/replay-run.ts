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

export function shown(config: AcceptanceConfig, path: string): string {
	const rel = relative(config.project, path);
	return rel === "" || rel.startsWith("..") ? path : rel.split(sep).join("/");
}

export function runIds(config: AcceptanceConfig): ReadonlySet<string> {
	try {
		return new Set(readdirSync(config.runsDir));
	} catch {
		return new Set();
	}
}

const CLOCK_SKEW_MS = 5000;

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

function realOf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

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
