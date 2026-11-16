/**
 * What the CI insight reports are computed from: workflow runs with their jobs
 * and steps, as plain values. Whoever reads them from GitHub parses them into
 * these types first; nothing here does I/O or reads a clock. Every time is
 * epoch milliseconds.
 */

import { compareTextIgnoringCase } from "./order.js";

/** How a run, job or step ended. `unknown` covers one that has not ended yet. */
export type InsightConclusion =
	| "success"
	| "failure"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "unknown";

export type InsightStep = Readonly<{
	name: string;
	/** Position in the job, from 1. */
	number: number;
	conclusion: InsightConclusion;
	startedAtMs?: number;
	completedAtMs?: number;
}>;

export type InsightJob = Readonly<{
	id: number;
	name: string;
	/** The job's `runs-on` labels. */
	labels: readonly string[];
	runnerName?: string;
	runnerGroup?: string;
	conclusion: InsightConclusion;
	/** When the job was created and began waiting for a runner. */
	queuedAtMs: number;
	/** When a runner took it. Absent when none did. */
	startedAtMs?: number;
	completedAtMs?: number;
	steps: readonly InsightStep[];
	/** Names of the jobs it waits on, when known. */
	needs?: readonly string[];
	/** Ran on capacity GitHub bills per minute (GitHub-hosted, private repository). */
	billed: boolean;
	/** A routing job that hands the real work to another runner. Left out of waits. */
	relay?: boolean;
}>;

/** One attempt of a workflow run. A re-run is a second value with the same `id`. */
export type InsightRun = Readonly<{
	id: number;
	attempt: number;
	repository: string;
	workflow: string;
	workflowPath: string;
	/** push, pull_request, schedule, merge_group, workflow_dispatch, ... */
	event: string;
	branch: string;
	defaultBranch: string;
	headSha: string;
	actor: string;
	conclusion: InsightConclusion;
	createdAtMs: number;
	completedAtMs?: number;
	jobs: readonly InsightJob[];
	/** Files a pull request changed, when known. */
	changedPaths?: readonly string[];
	/** Pull request title, or the head commit's subject. */
	title?: string;
}>;

// public-contract: the length of one minute, the unit GitHub bills a job in.
export const MS_PER_MINUTE = 60_000;

// public-contract: the name of the step GitHub itself runs before a job's own steps.
export const SETUP_STEP_NAME = "Set up job";

/**
 * How long a job waited for a runner. Undefined when no runner took it. Never
 * negative: timestamps a second out of order count as no wait.
 */
export function jobWaitMs(job: InsightJob): number | undefined {
	if (job.startedAtMs === undefined) return undefined;
	return Math.max(0, job.startedAtMs - job.queuedAtMs);
}

/**
 * How long a job ran on its runner. Undefined unless it both started and
 * finished. Never negative.
 */
export function jobRunMs(job: InsightJob): number | undefined {
	if (job.startedAtMs === undefined || job.completedAtMs === undefined) {
		return undefined;
	}
	return Math.max(0, job.completedAtMs - job.startedAtMs);
}

/** A job's run time in fractional minutes. 0 unless it started and finished. */
export function jobRunMinutes(job: InsightJob): number {
	return (jobRunMs(job) ?? 0) / MS_PER_MINUTE;
}

/**
 * The minutes GitHub bills for a job that started and finished: its run time
 * rounded up to a whole minute, and never less than one. 0 for a job that did
 * not start or has not finished. Whether the job is billed at all is `billed`.
 */
export function jobBilledMinutes(job: InsightJob): number {
	const runMs = jobRunMs(job);
	if (runMs === undefined) return 0;
	return Math.max(1, Math.ceil(runMs / MS_PER_MINUTE));
}

/**
 * True when the job got past GitHub's own "Set up job" step: some other step
 * has a conclusion that is not `skipped`. A job that failed without this never
 * ran any of the workflow's own commands.
 */
export function ranSteps(job: InsightJob): boolean {
	return job.steps.some(
		(step) => step.name !== SETUP_STEP_NAME && step.conclusion !== "skipped",
	);
}

// public-contract: the runner key of a job that names no runs-on label.
export const NO_LABELS_KEY = "(no labels)";

/**
 * The name a report groups runners by: the `runs-on` labels, trimmed, sorted
 * without regard to case and joined with ", ". Sorting makes
 * `[self-hosted, linux]` and `[linux, self-hosted]` one runner.
 */
export function runnerKey(labels: readonly string[]): string {
	const named = labels
		.map((label) => label.trim())
		.filter((label) => label.length > 0)
		.sort(compareTextIgnoringCase);
	return named.length === 0 ? NO_LABELS_KEY : named.join(", ");
}

/** The name a report groups jobs by: `workflow / job`. */
export function jobKey(workflow: string, jobName: string): string {
	return `${workflow} / ${jobName}`;
}

/** The run time of every job in a run that started and finished, in fractional minutes. */
export function runJobMinutes(run: InsightRun): number {
	return run.jobs.reduce((minutes, job) => minutes + jobRunMinutes(job), 0);
}
