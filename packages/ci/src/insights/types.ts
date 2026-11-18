import { compareTextIgnoringCase } from "./order.js";

export type InsightConclusion =
	| "success"
	| "failure"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "unknown";

export type InsightStep = Readonly<{
	name: string;
	number: number;
	conclusion: InsightConclusion;
	startedAtMs?: number;
	completedAtMs?: number;
}>;

export type InsightJob = Readonly<{
	id: number;
	name: string;
	labels: readonly string[];
	runnerName?: string;
	runnerGroup?: string;
	conclusion: InsightConclusion;
	queuedAtMs: number;
	startedAtMs?: number;
	completedAtMs?: number;
	steps: readonly InsightStep[];
	needs?: readonly string[];
	billed: boolean;
	relay?: boolean;
}>;

export type InsightRun = Readonly<{
	id: number;
	attempt: number;
	repository: string;
	workflow: string;
	workflowPath: string;
	event: string;
	branch: string;
	defaultBranch: string;
	headSha: string;
	actor: string;
	conclusion: InsightConclusion;
	createdAtMs: number;
	completedAtMs?: number;
	jobs: readonly InsightJob[];
	changedPaths?: readonly string[];
	title?: string;
}>;

// public-contract: the length of one minute, the unit GitHub bills a job in.
export const MS_PER_MINUTE = 60_000;

// public-contract: the name of the step GitHub itself runs before a job's own steps.
export const SETUP_STEP_NAME = "Set up job";

export function jobWaitMs(job: InsightJob): number | undefined {
	if (job.startedAtMs === undefined) return undefined;
	return Math.max(0, job.startedAtMs - job.queuedAtMs);
}

export function jobRunMs(job: InsightJob): number | undefined {
	if (job.startedAtMs === undefined || job.completedAtMs === undefined) {
		return undefined;
	}
	return Math.max(0, job.completedAtMs - job.startedAtMs);
}

export function jobRunMinutes(job: InsightJob): number {
	return (jobRunMs(job) ?? 0) / MS_PER_MINUTE;
}

export function jobBilledMinutes(job: InsightJob): number {
	const runMs = jobRunMs(job);
	if (runMs === undefined) return 0;
	return Math.max(1, Math.ceil(runMs / MS_PER_MINUTE));
}

export function ranSteps(job: InsightJob): boolean {
	return job.steps.some(
		(step) => step.name !== SETUP_STEP_NAME && step.conclusion !== "skipped",
	);
}

// public-contract: the runner key of a job that names no runs-on label.
export const NO_LABELS_KEY = "(no labels)";

export function runnerKey(labels: readonly string[]): string {
	const named = labels
		.map((label) => label.trim())
		.filter((label) => label.length > 0)
		.sort(compareTextIgnoringCase);
	return named.length === 0 ? NO_LABELS_KEY : named.join(", ");
}

export function jobKey(workflow: string, jobName: string): string {
	return `${workflow} / ${jobName}`;
}

export function runJobMinutes(run: InsightRun): number {
	return run.jobs.reduce((minutes, job) => minutes + jobRunMinutes(job), 0);
}
