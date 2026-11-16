/**
 * Nine signals of CI time that did not have to be spent, in three areas:
 * minutes paid for (cost), minutes a person waited (speed) and work started
 * that the change did not call for (complexity).
 *
 * Each signal finds its occurrences in a set of run attempts, adds up the
 * minutes they cover and names the worst offenders. A signal is `shown` only
 * when it covers enough minutes, both outright and as a share of all job
 * minutes in the input, so a report leads with what matters in this
 * repository rather than listing every signal every time.
 *
 * Minutes are fractional (milliseconds / 60 000) throughout. Pure functions.
 */

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
	/** A job waits too long for a runner when it waits longer than this. */
	queueWaitMs: number;
	/** A run's last job holds it up when it runs on alone for at least this long. */
	slowestJobMs: number;
	/** A run fans out wide when it starts at least this many jobs. */
	fanoutJobs: number;
	/** A billed job is short when it runs for less than this. */
	shortJobMs: number;
	/** A signal is shown only when it covers at least this many minutes. */
	minMinutes: number;
	/** ... and at least this share of all job minutes in the input. */
	minShare: number;
	/** The most offenders a signal names. */
	maxRows: number;
	/** An offender with fewer minutes than this is not named. */
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

/** One offender: everything a signal found under one runner, job or workflow. */
export type SignalRow = Readonly<{
	key: string;
	minutes: number;
	occurrences: number;
}>;

export type CiSignal = Readonly<{
	id: CiSignalId;
	area: SignalArea;
	/** Minutes over every occurrence, named in `rows` or not. */
	minutes: number;
	occurrences: number;
	shown: boolean;
	rows: readonly SignalRow[];
}>;

export type CiSignals = Readonly<{
	/** Run time of every job that started and finished, in minutes. */
	totalJobMinutes: number;
	signals: readonly CiSignal[];
}>;

/** One occurrence of a signal, before occurrences are grouped into rows. */
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

/** LICENSE, COPYING or NOTICE, alone or with a suffix such as LICENSE-MIT. */
const LEGAL_FILE_NAME = /^(?:licen[cs]e|copying|notice)(?:-[a-z0-9.]+)?$/i;

/** `docs:` or `docs(<scope>):` at the start of a title. */
const DOCS_TITLE = /^docs(?:\([^()\r\n]*\))?:/i;

/** A workflow named for documentation is meant to run when documentation changes. */
const DOCS_WORKFLOW = /doc/i;

/**
 * True for a path that holds documentation rather than code: a file ending in
 * md, mdx, markdown, rst, adoc or txt; anything under a folder named `doc` or
 * `docs`; and LICENSE, COPYING and NOTICE files at any depth. Letter case is
 * ignored. A legal file counts by its whole name (`LICENSE`, `LICENSE-MIT`),
 * so a source file such as `notice.ts` does not.
 */
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

/**
 * True when a run was started by a change to documentation only. The changed
 * paths decide when they are known: every one must be documentation, and a
 * change with no paths is not a documentation change. Only when the paths are
 * not known does the title decide, by starting with `docs:` or
 * `docs(<scope>):`.
 */
function changedDocsOnly(run: InsightRun): boolean {
	if (run.changedPaths !== undefined) {
		return run.changedPaths.length > 0 && run.changedPaths.every(isDocsPath);
	}
	return run.title !== undefined && DOCS_TITLE.test(run.title.trim());
}

/** Non-relay jobs that waited longer than `queueWaitMs` for a runner. */
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

/** The jobs of a run that started and finished, last to finish first. */
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

/**
 * Run attempts held up by one job. The job that finished last counts when it
 * names no `needs` and started before the next-to-last job finished, so it ran
 * alongside the others rather than as a later stage. The minutes are how long
 * the run went on with only that job left, and count only from `slowestJobMs`.
 *
 * "Finished" means started and finished: a skipped job never held a run up.
 * Two jobs finishing in the same millisecond leave no job running alone.
 */
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

/**
 * Jobs that failed or timed out after running steps, and passed when the same
 * run was tried again. The minutes are the failed attempt's run time.
 *
 * Only the very next attempt of the same run is looked at, and every job of
 * that name in it must have succeeded: when a name is not unique, one success
 * does not show which of the jobs recovered.
 */
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

/**
 * Jobs a runner started that failed without running a step: the runner broke,
 * not the job. The minutes are the job's run time, often next to nothing; the
 * count is what matters.
 */
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

/** Minutes of a run's jobs that fall after `fromMs`. */
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

/**
 * Runs on a branch other than the default one that kept going after a newer
 * run of the same workflow started on that branch. The minutes are the older
 * run's job minutes, billed or not, from the moment the newer run was created.
 *
 * The newer run is another run id of the same repository, workflow file,
 * branch and event, created after the older run and before it completed; the
 * earliest such run sets the cut-off. The same event is required because a
 * push run and a pull request run of one commit start together and would not
 * replace each other (that is the `same-commit` signal). A run that was
 * cancelled or skipped, or has not completed, is not counted.
 */
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

/**
 * Push runs of a commit that the same workflow also ran for a pull request.
 * The push run is the extra one, and the minutes are all of its job minutes.
 */
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

/**
 * Billed jobs that ran for less than `shortJobMs`. GitHub bills a whole minute
 * for any part of one, so the minutes are the part of the first billed minute
 * the job did not use.
 */
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

/**
 * Pull request runs for a change to documentation only, in workflows that are
 * not themselves about documentation. The minutes are all of the run's job
 * minutes.
 */
function docsChangeFindings(runs: readonly InsightRun[]): readonly Finding[] {
	const findings: Finding[] = [];
	for (const run of runs) {
		if (run.event !== "pull_request") continue;
		if (DOCS_WORKFLOW.test(run.workflow) || !changedDocsOnly(run)) continue;
		findings.push({ key: run.workflow, minutes: runJobMinutes(run) });
	}
	return findings;
}

/**
 * Push and pull request runs on a branch other than the default one in which
 * at least `fanoutJobs` non-relay jobs started. The minutes are all of the
 * run's job minutes.
 */
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

/** The worst offenders: most minutes first, then by key; small ones dropped. */
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

/**
 * The nine signals over a set of run attempts, in the order of
 * `CI_SIGNAL_IDS`.
 *
 * A signal is `shown` when it has at least one occurrence, covers at least
 * `minMinutes`, and covers at least `minShare` of all job minutes in the
 * input. Time spent waiting is measured against job minutes too, though it is
 * not part of them.
 */
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
