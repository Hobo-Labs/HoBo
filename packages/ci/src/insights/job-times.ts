import { compareText } from "./order.js";
import {
	type InsightConclusion,
	type InsightJob,
	type InsightRun,
	jobRunMs,
	jobWaitMs,
	runnerKey,
} from "./types.js";

export function percentile(
	values: readonly number[],
	p: number,
): number | undefined {
	if (!(p > 0 && p <= 100)) return undefined;
	const sorted = values
		.filter((value) => Number.isFinite(value))
		.sort((left, right) => left - right);

	const rank = Math.max(1, Math.ceil((p * sorted.length) / 100 - 1e-9));
	return sorted[rank - 1];
}

export function median(values: readonly number[]): number | undefined {
	return percentile(values, 50);
}

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

export const DEFAULT_MISSED_AFTER_MS = 600_000;

export type RunnerTimeOptions = Readonly<{
	nowMs?: number;
	missedAfterMs?: number;
}>;

export type RunnerTimes = Readonly<{
	key: string;
	jobs: number;
	started: number;
	startedShare: number;
	medianWaitMs: number | undefined;
	medianRunMs: number | undefined;
	p90RunMs: number | undefined;
	successRate: number | undefined;
}>;

type RunnerTally = {
	jobs: number;
	started: number;
	waits: number[];
	runTimes: number[];
	conclusions: InsightConclusion[];
};

function missedByRunner(job: InsightJob, options: RunnerTimeOptions): boolean {
	if (job.completedAtMs !== undefined) return true;
	if (options.nowMs === undefined) return false;
	const missedAfterMs = options.missedAfterMs ?? DEFAULT_MISSED_AFTER_MS;
	return options.nowMs - job.queuedAtMs > missedAfterMs;
}

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
	sampleCap: number;
	enoughRuns: number;
	fewRuns: number;
	baselineKey: string;
	minSharedJobs: number;
}>;

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
	runs: number;
	medianRunMs: number;
	p90RunMs: number;
	confidence: JobTimeConfidence;
}>;

export type RunnerSpeedup = Readonly<{
	key: string;
	ratio: number;
}>;

export type JobTimes = Readonly<{
	job: string;
	workflow: string;
	runners: readonly JobRunnerTimes[];
	fastest: string | undefined;
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
	runs: number;
	successRate: number | undefined;
	medianMs: number | undefined;
	p90Ms: number | undefined;
	medianWaitMs: number | undefined;
	slowestJob: string | undefined;
}>;

type WorkflowTally = {
	runs: number;
	conclusions: InsightConclusion[];
	durations: number[];
	waits: number[];
	runTimesByJob: Map<string, number[]>;
};

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
		for (const job of run.jobs) {
			if (job.relay === true) continue;
			const waitMs = jobWaitMs(job);
			if (waitMs !== undefined) tally.waits.push(waitMs);
			const runMs = jobRunMs(job);
			if (job.conclusion !== "success" || runMs === undefined) continue;
			const runTimes = tally.runTimesByJob.get(job.name) ?? [];
			tally.runTimesByJob.set(job.name, runTimes);
			runTimes.push(runMs);
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
