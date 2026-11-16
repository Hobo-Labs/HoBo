/**
 * How long CI takes, three ways: per runner (how long jobs wait for it, how
 * long they run on it and how often it takes them at all), per job on each
 * runner it has run on (which runner is fastest for this job), and per
 * workflow.
 *
 * Run-time figures use successful runs only: a job that failed early would
 * make its runner look fast. Medians and percentiles are nearest-rank, so
 * every figure is a duration that actually happened.
 *
 * Pure functions: the caller passes the time as `nowMs` where one is needed.
 */

import { compareText } from "./order.js";
import {
	type InsightConclusion,
	type InsightJob,
	type InsightRun,
	jobRunMs,
	jobWaitMs,
	runnerKey,
} from "./types.js";

/**
 * The nearest-rank percentile: the smallest value that at least `p` percent of
 * the values are at or below. `p` is in (0, 100]. Undefined when there are no
 * values or `p` is outside that range. The values need not be sorted; ones
 * that are not finite numbers are ignored.
 */
export function percentile(
	values: readonly number[],
	p: number,
): number | undefined {
	if (!(p > 0 && p <= 100)) return undefined;
	const sorted = values
		.filter((value) => Number.isFinite(value))
		.sort((left, right) => left - right);
	// The small allowance keeps a rank that is whole on paper (70% of 10) from
	// being pushed up one by floating-point error.
	const rank = Math.max(1, Math.ceil((p * sorted.length) / 100 - 1e-9));
	return sorted[rank - 1];
}

/** The 50th percentile. For an even count this is the lower of the middle two. */
export function median(values: readonly number[]): number | undefined {
	return percentile(values, 50);
}

/** Successes over outcomes that say something about the work; undefined with none. */
function successRateOf(
	conclusions: readonly InsightConclusion[],
): number | undefined {
	const decided = conclusions.filter(
		(conclusion) =>
			conclusion === "success" ||
			conclusion === "failure" ||
			conclusion === "timed_out",
	);
	if (decided.length === 0) return undefined;
	const successes = decided.filter((conclusion) => conclusion === "success");
	return successes.length / decided.length;
}

// public-contract: how long a job may sit queued before it counts as missed by its runner.
export const DEFAULT_MISSED_AFTER_MS = 600_000;

export type RunnerTimeOptions = Readonly<{
	/** The time of the report. Without it, a job still queued is never counted as missed. */
	nowMs?: number;
	/** A job still queued counts as missed once it has waited longer than this. */
	missedAfterMs?: number;
}>;

export type RunnerTimes = Readonly<{
	/** The runner's `runs-on` labels, sorted and joined with ", ". */
	key: string;
	/** Jobs that asked for this runner and were either taken or missed. */
	jobs: number;
	/** Jobs the runner took. */
	started: number;
	/** `started / jobs`. */
	startedShare: number;
	/** Median wait of the jobs it took. Undefined when it took none. */
	medianWaitMs: number | undefined;
	/** Median and 90th percentile run time of its successful jobs. */
	medianRunMs: number | undefined;
	p90RunMs: number | undefined;
	/** Successes over jobs that ended in success, failure or a time-out. */
	successRate: number | undefined;
}>;

type RunnerTally = {
	jobs: number;
	started: number;
	waits: number[];
	runTimes: number[];
	conclusions: InsightConclusion[];
};

/** For a job no runner took: true when none is going to. */
function missedByRunner(job: InsightJob, options: RunnerTimeOptions): boolean {
	if (job.completedAtMs !== undefined) return true;
	if (options.nowMs === undefined) return false;
	const missedAfterMs = options.missedAfterMs ?? DEFAULT_MISSED_AFTER_MS;
	return options.nowMs - job.queuedAtMs > missedAfterMs;
}

/**
 * Per runner: how many jobs asked for it, how many it took, how long they
 * waited and ran, and how often they passed. Most jobs first, then by key.
 *
 * A job counts as missed when no runner took it and it either ended anyway or
 * has been queued for longer than `missedAfterMs` at `nowMs`. A job still
 * inside that window is not counted yet, and a runner with nothing but such
 * jobs is left out. Relay jobs are left out, and so are skipped jobs: a job
 * skipped by its `if:` never asked for a runner, so it was not missed by one.
 */
export function runnerTimes(
	runs: readonly InsightRun[],
	options: RunnerTimeOptions = {},
): readonly RunnerTimes[] {
	const talliesByRunner = new Map<string, RunnerTally>();
	for (const run of runs) {
		for (const job of run.jobs) {
			if (job.relay === true || job.conclusion === "skipped") continue;
			const waitMs = jobWaitMs(job);
			if (waitMs === undefined && !missedByRunner(job, options)) continue;
			const key = runnerKey(job.labels);
			const tally = talliesByRunner.get(key) ?? {
				jobs: 0,
				started: 0,
				waits: [],
				runTimes: [],
				conclusions: [],
			};
			talliesByRunner.set(key, tally);
			tally.jobs += 1;
			tally.conclusions.push(job.conclusion);
			if (waitMs === undefined) continue;
			tally.started += 1;
			tally.waits.push(waitMs);
			const runMs = jobRunMs(job);
			if (job.conclusion === "success" && runMs !== undefined) {
				tally.runTimes.push(runMs);
			}
		}
	}
	return [...talliesByRunner.entries()]
		.map(
			([key, tally]): RunnerTimes => ({
				key,
				jobs: tally.jobs,
				started: tally.started,
				startedShare: tally.started / tally.jobs,
				medianWaitMs: median(tally.waits),
				medianRunMs: median(tally.runTimes),
				p90RunMs: percentile(tally.runTimes, 90),
				successRate: successRateOf(tally.conclusions),
			}),
		)
		.sort(
			(left, right) =>
				right.jobs - left.jobs || compareText(left.key, right.key),
		);
}

export type JobTimeOptions = Readonly<{
	/** The most successful runs of a job on one runner that are measured, newest first. */
	sampleCap: number;
	/** From this many runs a figure is `enough` to rely on. */
	enoughRuns: number;
	/** Under this many runs a figure is `sparse`. */
	fewRuns: number;
	/** The runner the others are compared with. */
	baselineKey: string;
	/** A runner is compared with the baseline only when both have this many runs. */
	minSharedJobs: number;
}>;

// public-contract: the sampling and confidence limits a job-time report uses unless overridden.
export const DEFAULT_JOB_TIME_OPTIONS: JobTimeOptions = {
	sampleCap: 50,
	enoughRuns: 20,
	fewRuns: 5,
	baselineKey: "ubuntu-latest",
	minSharedJobs: 3,
};

export type JobTimeConfidence = "enough" | "few" | "sparse";

export type JobRunnerTimes = Readonly<{
	key: string;
	/** Successful runs measured, at most `sampleCap`. */
	runs: number;
	medianRunMs: number;
	p90RunMs: number;
	confidence: JobTimeConfidence;
}>;

export type RunnerSpeedup = Readonly<{
	key: string;
	/** Baseline median over this runner's median: 2 means twice as fast as the baseline. */
	ratio: number;
}>;

export type JobTimes = Readonly<{
	job: string;
	workflow: string;
	/** Fastest median first. */
	runners: readonly JobRunnerTimes[];
	/** The runner with the lowest median among those not `sparse`. */
	fastest: string | undefined;
	/** Every runner other than the baseline that can be compared with it. */
	speedup: readonly RunnerSpeedup[];
}>;

type RunSample = Readonly<{ runMs: number; completedAtMs: number }>;

type JobSamples = Readonly<{
	workflow: string;
	job: string;
	samplesByRunner: Map<string, RunSample[]>;
}>;

function confidenceOf(
	runs: number,
	options: JobTimeOptions,
): JobTimeConfidence {
	if (runs >= options.enoughRuns) return "enough";
	return runs < options.fewRuns ? "sparse" : "few";
}

function runnerTimesOfJob(
	key: string,
	samples: readonly RunSample[],
	options: JobTimeOptions,
): JobRunnerTimes | undefined {
	const newest = [...samples]
		.sort((left, right) => right.completedAtMs - left.completedAtMs)
		.slice(0, Math.max(1, options.sampleCap))
		.map((sample) => sample.runMs);
	const medianRunMs = median(newest);
	const p90RunMs = percentile(newest, 90);
	if (medianRunMs === undefined || p90RunMs === undefined) return undefined;
	return {
		key,
		runs: newest.length,
		medianRunMs,
		p90RunMs,
		confidence: confidenceOf(newest.length, options),
	};
}

function speedupOf(
	runners: readonly JobRunnerTimes[],
	options: JobTimeOptions,
): readonly RunnerSpeedup[] {
	const baselineKey = options.baselineKey.trim().toLowerCase();
	const baseline = runners.find(
		(runner) => runner.key.toLowerCase() === baselineKey,
	);
	if (baseline === undefined || baseline.runs < options.minSharedJobs) {
		return [];
	}
	const speedup: RunnerSpeedup[] = [];
	for (const runner of runners) {
		if (runner === baseline || runner.runs < options.minSharedJobs) continue;
		if (runner.medianRunMs <= 0) continue;
		speedup.push({
			key: runner.key,
			ratio: baseline.medianRunMs / runner.medianRunMs,
		});
	}
	return speedup;
}

/**
 * Per job, the run time on each runner it has succeeded on, from the newest
 * `sampleCap` successful runs on that runner. Ordered by workflow, then job.
 *
 * `fastest` is the runner with the lowest median among those with at least
 * `fewRuns` runs. `speedup` compares each other runner's median with the
 * baseline runner's when both have at least `minSharedJobs` runs; the baseline
 * is matched without regard to case. Relay jobs are left out: a routing job's
 * run time says nothing about the runner the work went to.
 */
export function jobTimes(
	runs: readonly InsightRun[],
	options?: Partial<JobTimeOptions>,
): readonly JobTimes[] {
	const limits: JobTimeOptions = { ...DEFAULT_JOB_TIME_OPTIONS, ...options };
	const samplesByJob = new Map<string, JobSamples>();
	for (const run of runs) {
		for (const job of run.jobs) {
			const runMs = jobRunMs(job);
			if (job.relay === true || job.conclusion !== "success") continue;
			if (runMs === undefined || job.completedAtMs === undefined) continue;
			const name = [run.workflow, job.name].join("\n");
			const entry = samplesByJob.get(name) ?? {
				workflow: run.workflow,
				job: job.name,
				samplesByRunner: new Map<string, RunSample[]>(),
			};
			samplesByJob.set(name, entry);
			const key = runnerKey(job.labels);
			const samples = entry.samplesByRunner.get(key) ?? [];
			entry.samplesByRunner.set(key, samples);
			samples.push({ runMs, completedAtMs: job.completedAtMs });
		}
	}
	return [...samplesByJob.values()]
		.map((entry): JobTimes => {
			const runners: JobRunnerTimes[] = [];
			for (const [key, samples] of entry.samplesByRunner) {
				const times = runnerTimesOfJob(key, samples, limits);
				if (times !== undefined) runners.push(times);
			}
			runners.sort(
				(left, right) =>
					left.medianRunMs - right.medianRunMs ||
					compareText(left.key, right.key),
			);
			return {
				job: entry.job,
				workflow: entry.workflow,
				runners,
				fastest: runners.find((runner) => runner.confidence !== "sparse")?.key,
				speedup: speedupOf(runners, limits),
			};
		})
		.sort(
			(left, right) =>
				compareText(left.workflow, right.workflow) ||
				compareText(left.job, right.job),
		);
}

export type WorkflowTimes = Readonly<{
	workflow: string;
	/** Run attempts seen, whatever their result. */
	runs: number;
	/** Successes over attempts that ended in success, failure or a time-out. */
	successRate: number | undefined;
	/** Median and 90th percentile duration of successful attempts, created to completed. */
	medianMs: number | undefined;
	p90Ms: number | undefined;
	/** Median, over attempts, of the time their jobs spent waiting for runners. */
	medianWaitMs: number | undefined;
	/** The job with the highest median run time. */
	slowestJob: string | undefined;
}>;

type WorkflowTally = {
	runs: number;
	conclusions: InsightConclusion[];
	durations: number[];
	waits: number[];
	runTimesByJob: Map<string, number[]>;
};

/** The job name with the highest median run time; the first by name on a tie. */
function slowestJobOf(
	runTimesByJob: ReadonlyMap<string, readonly number[]>,
): string | undefined {
	let slowest: Readonly<{ name: string; medianMs: number }> | undefined;
	for (const [name, runTimes] of runTimesByJob) {
		const medianMs = median(runTimes);
		if (medianMs === undefined) continue;
		const slower =
			slowest === undefined ||
			medianMs > slowest.medianMs ||
			(medianMs === slowest.medianMs && compareText(name, slowest.name) < 0);
		if (slower) slowest = { name, medianMs };
	}
	return slowest?.name;
}

/**
 * Per workflow: how often it passes, how long a successful attempt takes from
 * created to completed, how long its jobs wait for runners, and which job is
 * slowest. Most attempts first, then by name.
 *
 * The wait of an attempt is the sum of the waits of its non-relay jobs that
 * started; attempts of any result count, but one in which no such job started
 * does not. The slowest job is judged on successful, non-relay jobs.
 */
export function workflowTimes(
	runs: readonly InsightRun[],
): readonly WorkflowTimes[] {
	const talliesByWorkflow = new Map<string, WorkflowTally>();
	for (const run of runs) {
		const tally = talliesByWorkflow.get(run.workflow) ?? {
			runs: 0,
			conclusions: [],
			durations: [],
			waits: [],
			runTimesByJob: new Map<string, number[]>(),
		};
		talliesByWorkflow.set(run.workflow, tally);
		tally.runs += 1;
		tally.conclusions.push(run.conclusion);
		if (run.conclusion === "success" && run.completedAtMs !== undefined) {
			tally.durations.push(Math.max(0, run.completedAtMs - run.createdAtMs));
		}
		const waits: number[] = [];
		for (const job of run.jobs) {
			if (job.relay === true) continue;
			const waitMs = jobWaitMs(job);
			if (waitMs !== undefined) waits.push(waitMs);
			const runMs = jobRunMs(job);
			if (job.conclusion !== "success" || runMs === undefined) continue;
			const runTimes = tally.runTimesByJob.get(job.name) ?? [];
			tally.runTimesByJob.set(job.name, runTimes);
			runTimes.push(runMs);
		}
		if (waits.length > 0) {
			tally.waits.push(waits.reduce((total, waitMs) => total + waitMs, 0));
		}
	}
	return [...talliesByWorkflow.entries()]
		.map(
			([workflow, tally]): WorkflowTimes => ({
				workflow,
				runs: tally.runs,
				successRate: successRateOf(tally.conclusions),
				medianMs: median(tally.durations),
				p90Ms: percentile(tally.durations, 90),
				medianWaitMs: median(tally.waits),
				slowestJob: slowestJobOf(tally.runTimesByJob),
			}),
		)
		.sort(
			(left, right) =>
				right.runs - left.runs || compareText(left.workflow, right.workflow),
		);
}
