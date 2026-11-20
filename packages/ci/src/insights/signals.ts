import { compareText } from "./order.js";
import {
	type InsightJob,
	type InsightRun,
	jobKey,
	jobRunMinutes,
	jobRunMs,
	jobWaitMs,
	MS_PER_MINUTE,
	ranSteps,
	runJobMinutes,
	runnerKey,
} from "./types.js";

// public-contract: the signal ids, in the order a report lists them.
export const CI_SIGNAL_IDS = [
	"no-concurrency",
	"same-commit",
	"short-jobs",
	"queue-waits",
	"slowest-job",
	"flaky-jobs",
	"runner-failures",
	"docs-changes",
	"wide-fanout",
] as const;

export type CiSignalId = (typeof CI_SIGNAL_IDS)[number];

export type SignalArea = "cost" | "speed" | "complexity";

export type SignalThresholds = Readonly<{
	queueWaitMs: number;
	slowestJobMs: number;
	fanoutJobs: number;
	shortJobMs: number;
	minMinutes: number;
	minShare: number;
	maxRows: number;
	minRowMinutes: number;
}>;

// public-contract: the thresholds a signal report uses unless the caller overrides them.
export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
	queueWaitMs: 60_000,
	slowestJobMs: 60_000,
	fanoutJobs: 10,
	shortJobMs: 60_000,
	minMinutes: 30,
	minShare: 0.01,
	maxRows: 5,
	minRowMinutes: 1,
};

export type SignalRow = Readonly<{
	key: string;
	minutes: number;
	occurrences: number;
}>;

export type CiSignal = Readonly<{
	id: CiSignalId;
	area: SignalArea;
	minutes: number;
	occurrences: number;
	shown: boolean;
	rows: readonly SignalRow[];
}>;

export type CiSignals = Readonly<{
	totalJobMinutes: number;
	signals: readonly CiSignal[];
}>;

type Finding = Readonly<{ key: string; minutes: number }>;

type Detector = Readonly<{
	id: CiSignalId;
	area: SignalArea;
	find: (
		runs: readonly InsightRun[],
		thresholds: SignalThresholds,
	) => readonly Finding[];
}>;

const DOCS_EXTENSIONS = new Set([
	"md",
	"mdx",
	"markdown",
	"rst",
	"adoc",
	"txt",
]);

const DOCS_FOLDERS = new Set(["doc", "docs"]);

const LEGAL_FILE_NAME = /^(?:licen[cs]e|copying|notice)(?:-[a-z0-9.]+)?$/i;

const DOCS_TITLE = /^docs(?:\([^()\r\n]*\))?:/i;

const DOCS_WORKFLOW = /\bdoc(?:s|umentation)?\b/i;

export function isDocsPath(path: string): boolean {
	const segments = path
		.split(/[/\\]/)
		.map((segment) => segment.trim().toLowerCase())
		.filter((segment) => segment.length > 0);
	const fileName = segments.at(-1);
	if (fileName === undefined) return false;
	if (segments.some((segment) => DOCS_FOLDERS.has(segment))) return true;
	if (LEGAL_FILE_NAME.test(fileName)) return true;
	const dot = fileName.lastIndexOf(".");
	return dot > 0 && DOCS_EXTENSIONS.has(fileName.slice(dot + 1));
}

function changedDocsOnly(run: InsightRun): boolean {
	if (run.changedPaths !== undefined) {
		return run.changedPaths.length > 0 && run.changedPaths.every(isDocsPath);
	}
	return run.title !== undefined && DOCS_TITLE.test(run.title.trim());
}

function queueWaitFindings(
	runs: readonly InsightRun[],
	thresholds: SignalThresholds,
): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		for (const job of run.jobs) {
			if (job.relay === true) continue;
			const waitMs = jobWaitMs(job);
			if (waitMs === undefined || waitMs <= thresholds.queueWaitMs) continue;
			findings.push({
				key: runnerKey(job.labels),
				minutes: waitMs / MS_PER_MINUTE,
			});
		}
	}
	return findings;
}

type FinishedJob = Readonly<{
	job: InsightJob;
	startedAtMs: number;
	completedAtMs: number;
}>;

function finishedJobs(run: InsightRun): readonly FinishedJob[] {
	const finished: FinishedJob[] = [];
	for (const job of run.jobs) {
		if (job.startedAtMs === undefined || job.completedAtMs === undefined) {
			continue;
		}
		finished.push({
			job,
			startedAtMs: job.startedAtMs,
			completedAtMs: job.completedAtMs,
		});
	}
	return finished.sort(
		(left, right) =>
			right.completedAtMs - left.completedAtMs || left.job.id - right.job.id,
	);
}

function slowestJobFindings(
	runs: readonly InsightRun[],
	thresholds: SignalThresholds,
): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		const [last, previous] = finishedJobs(run);
		if (last === undefined || previous === undefined) continue;
		if ((last.job.needs?.length ?? 0) > 0) continue;
		if (last.startedAtMs >= previous.completedAtMs) continue;
		const aloneMs = last.completedAtMs - previous.completedAtMs;
		if (aloneMs <= 0 || aloneMs < thresholds.slowestJobMs) continue;
		findings.push({
			key: jobKey(run.workflow, last.job.name),
			minutes: aloneMs / MS_PER_MINUTE,
		});
	}
	return findings;
}

function attemptKey(repository: string, id: number, attempt: number): string {
	return [repository, id, attempt].join("\n");
}

function flakyJobFindings(runs: readonly InsightRun[]): readonly Finding[] {
	const runsByAttempt = new Map<string, InsightRun>();
	for (const run of runs) {
		const key = attemptKey(run.repository, run.id, run.attempt);
		if (!runsByAttempt.has(key)) runsByAttempt.set(key, run);
	}
	const findings: Finding[] = [];
	for (const run of runs) {
		const next = runsByAttempt.get(
			attemptKey(run.repository, run.id, run.attempt + 1),
		);
		if (next === undefined) continue;
		for (const job of run.jobs) {
			if (job.conclusion !== "failure" && job.conclusion !== "timed_out") {
				continue;
			}
			if (!ranSteps(job)) continue;
			const retried = next.jobs.filter((later) => later.name === job.name);
			if (retried.length === 0) continue;
			if (!retried.every((later) => later.conclusion === "success")) continue;
			findings.push({
				key: jobKey(run.workflow, job.name),
				minutes: jobRunMinutes(job),
			});
		}
	}
	return findings;
}

function runnerFailureFindings(
	runs: readonly InsightRun[],
): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		for (const job of run.jobs) {
			if (job.conclusion !== "failure") continue;
			if (job.startedAtMs === undefined || ranSteps(job)) continue;
			findings.push({
				key: runnerKey(job.labels),
				minutes: jobRunMinutes(job),
			});
		}
	}
	return findings;
}

function jobMinutesAfter(run: InsightRun, fromMs: number): number {
	let overlapMs = 0;
	for (const job of run.jobs) {
		if (job.startedAtMs === undefined || job.completedAtMs === undefined) {
			continue;
		}
		overlapMs += Math.max(
			0,
			job.completedAtMs - Math.max(job.startedAtMs, fromMs),
		);
	}
	return overlapMs / MS_PER_MINUTE;
}

function noConcurrencyFindings(
	runs: readonly InsightRun[],
): readonly Finding[] {
	const runsByLane = new Map<string, InsightRun[]>();
	for (const run of runs) {
		if (run.branch === run.defaultBranch) continue;
		const lane = [run.repository, run.workflowPath, run.branch, run.event].join(
			"\n",
		);
		const sameLane = runsByLane.get(lane);
		if (sameLane === undefined) runsByLane.set(lane, [run]);
		else sameLane.push(run);
	}
	const findings: Finding[] = [];
	for (const sameLane of runsByLane.values()) {
		for (const run of sameLane) {
			const completedAtMs = run.completedAtMs;
			if (completedAtMs === undefined) continue;
			if (run.conclusion === "cancelled" || run.conclusion === "skipped") {
				continue;
			}
			let newerAtMs: number | undefined;
			for (const other of sameLane) {
				if (other.id === run.id) continue;
				if (other.createdAtMs <= run.createdAtMs) continue;
				if (other.createdAtMs >= completedAtMs) continue;
				if (newerAtMs === undefined || other.createdAtMs < newerAtMs) {
					newerAtMs = other.createdAtMs;
				}
			}
			if (newerAtMs === undefined) continue;
			findings.push({
				key: run.workflow,
				minutes: jobMinutesAfter(run, newerAtMs),
			});
		}
	}
	return findings;
}

function commitKey(run: InsightRun): string {
	return [run.repository, run.workflowPath, run.headSha].join("\n");
}

function sameCommitFindings(runs: readonly InsightRun[]): readonly Finding[] {
	const pullRequestCommits = new Set<string>();
	for (const run of runs) {
		if (run.event === "pull_request") pullRequestCommits.add(commitKey(run));
	}
	const findings: Finding[] = [];
	for (const run of runs) {
		if (run.event !== "push" || !pullRequestCommits.has(commitKey(run))) {
			continue;
		}
		findings.push({ key: run.workflow, minutes: runJobMinutes(run) });
	}
	return findings;
}

function shortJobFindings(
	runs: readonly InsightRun[],
	thresholds: SignalThresholds,
): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		for (const job of run.jobs) {
			if (!job.billed) continue;
			const runMs = jobRunMs(job);
			if (runMs === undefined || runMs >= thresholds.shortJobMs) continue;
			findings.push({
				key: jobKey(run.workflow, job.name),
				minutes: Math.max(0, 1 - runMs / MS_PER_MINUTE),
			});
		}
	}
	return findings;
}

function docsChangeFindings(runs: readonly InsightRun[]): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		if (run.event !== "pull_request") continue;
		if (DOCS_WORKFLOW.test(run.workflow) || !changedDocsOnly(run)) continue;
		findings.push({ key: run.workflow, minutes: runJobMinutes(run) });
	}
	return findings;
}

function wideFanoutFindings(
	runs: readonly InsightRun[],
	thresholds: SignalThresholds,
): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		if (run.event !== "push" && run.event !== "pull_request") continue;
		if (run.branch === run.defaultBranch) continue;
		const started = run.jobs.filter(
			(job) => job.relay !== true && job.startedAtMs !== undefined,
		).length;
		if (started < thresholds.fanoutJobs) continue;
		findings.push({ key: run.workflow, minutes: runJobMinutes(run) });
	}
	return findings;
}

const DETECTORS: readonly Detector[] = [
	{ id: "no-concurrency", area: "cost", find: noConcurrencyFindings },
	{ id: "same-commit", area: "cost", find: sameCommitFindings },
	{ id: "short-jobs", area: "cost", find: shortJobFindings },
	{ id: "queue-waits", area: "speed", find: queueWaitFindings },
	{ id: "slowest-job", area: "speed", find: slowestJobFindings },
	{ id: "flaky-jobs", area: "speed", find: flakyJobFindings },
	{ id: "runner-failures", area: "speed", find: runnerFailureFindings },
	{ id: "docs-changes", area: "complexity", find: docsChangeFindings },
	{ id: "wide-fanout", area: "complexity", find: wideFanoutFindings },
];

function offenderRows(
	findings: readonly Finding[],
	thresholds: SignalThresholds,
): readonly SignalRow[] {
	const rowsByKey = new Map<string, SignalRow>();
	for (const finding of findings) {
		const row = rowsByKey.get(finding.key);
		rowsByKey.set(finding.key, {
			key: finding.key,
			minutes: (row?.minutes ?? 0) + finding.minutes,
			occurrences: (row?.occurrences ?? 0) + 1,
		});
	}
	return [...rowsByKey.values()]
		.filter((row) => row.minutes >= thresholds.minRowMinutes)
		.sort(
			(left, right) =>
				right.minutes - left.minutes || compareText(left.key, right.key),
		)
		.slice(0, Math.max(0, thresholds.maxRows));
}

export function ciSignals(
	runs: readonly InsightRun[],
	options?: Partial<SignalThresholds>,
): CiSignals {
	const thresholds: SignalThresholds = {
		...DEFAULT_SIGNAL_THRESHOLDS,
		...options,
	};
	const totalJobMinutes = runs.reduce(
		(minutes, run) => minutes + runJobMinutes(run),
		0,
	);
	const signals = DETECTORS.map((detector): CiSignal => {
		const findings = detector.find(runs, thresholds);
		const minutes = findings.reduce(
			(total, finding) => total + finding.minutes,
			0,
		);
		return {
			id: detector.id,
			area: detector.area,
			minutes,
			occurrences: findings.length,
			shown:
				findings.length > 0 &&
				minutes >= thresholds.minMinutes &&
				minutes >= thresholds.minShare * totalJobMinutes,
			rows: offenderRows(findings, thresholds),
		};
	});
	return { totalJobMinutes, signals };
}
