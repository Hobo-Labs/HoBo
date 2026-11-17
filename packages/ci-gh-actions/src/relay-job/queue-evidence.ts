/**
 * What GitHub's queue shows about one runner label, read with nothing more
 * than a job token (ADR-0183, job mode).
 *
 * A job token can list a repository's runs and their jobs, but not its
 * runners. So whether a self-hosted label is alive, busy or failing is read
 * from the jobs that asked for it: how many are still waiting and for how
 * long, and how quickly a runner took the ones it took.
 *
 * These are the rules this repository's own route job has run in production
 * (`labelLoad`, `takingJobs`, `refusingJobs` and the run-reading order in
 * `scripts/ci/route-runner.mts`), written again here so the relay job's
 * evaluator does not depend on a script. They agree on the same job lists.
 * As there, only a `queued` job counts as waiting for a runner. A `pending`
 * job is held back by a concurrency group, not by a missing runner (the
 * recorded fixture in `test/fixtures/relay-job/recorded-queue.json` has one:
 * a fleet probe waiting behind an older queued probe run), so it says nothing
 * about whether a label is full or failing.
 *
 * Pure functions: no clock, network or store. Parsers take GitHub's JSON and
 * return the parsed shape or nothing; they never throw.
 */
import { z } from "zod";

/** How long ago a pickup still says the label is taking jobs. */
export const QUEUE_RECENT_PICKUP_MS = 15 * 60_000;
/** How long a slow pickup still counts against a label. */
export const QUEUE_SLOW_PICKUP_MEMORY_MS = 60 * 60_000;
/** A job waiting this long was abandoned; it says nothing about now. */
export const QUEUE_STALE_WAIT_MS = 24 * 60 * 60_000;
/**
 * A run that started this soon before the one deciding, and has not chosen a
 * runner yet, is taken to be about to take a free runner.
 */
export const QUEUE_BURST_MS = 60_000;
/** The workflow whose only job is to be picked up by each self-hosted label. */
// public-contract: the probe workflow path the route job also reads first.
export const QUEUE_PROBE_WORKFLOW_PATH = ".github/workflows/fleet-probe.yml";
/** Probe runs read per decision, newest first. */
export const QUEUE_MAX_PROBE_RUNS = 3;
/** Finished runs read per decision, the longest-running first. */
export const QUEUE_MAX_FINISHED_RUNS = 3;

/** When a label is refusing jobs. */
export type QueueLimits = Readonly<{
	/** A job has waited this long, or a recent pickup took this long. */
	maxWaitSeconds: number;
	/** This many jobs are already waiting. */
	maxQueued: number;
}>;

// public-contract: the limits the route job uses when `runnerRouting.queue` sets none.
export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
	maxWaitSeconds: 120,
	maxQueued: 4,
};

/** A job seen in the queue. `startedAtMs` is set once a runner took it. */
export type QueueJob = Readonly<{
	runId: number;
	labels: readonly string[];
	createdAtMs: number;
	startedAtMs: number | undefined;
}>;

/** What the queue shows for one label. */
export type QueueEvidence = Readonly<{
	/** Jobs still waiting for it, abandoned ones left out. */
	waiting: number;
	oldestWaitSeconds: number;
	/** Jobs a runner took within `QUEUE_RECENT_PICKUP_MS`. */
	recentPickups: number;
	/** The longest any job taken within `QUEUE_SLOW_PICKUP_MEMORY_MS` waited. */
	slowestRecentPickupSeconds: number;
	/** When a runner last took a job for it; 0 when none was seen. */
	lastPickupAtMs: number;
}>;

/** One run from the run list. */
export type QueueRun = Readonly<{
	id: number;
	createdAtMs: number;
	updatedAtMs: number;
	finished: boolean;
	probe: boolean;
}>;

/** One page of a run's job list. */
export type QueueJobsPage = Readonly<{
	/** The jobs that say something about a label: waiting, or taken by a runner. */
	jobs: readonly QueueJob[];
	/** Some job has finished, so the run has chosen its runner. */
	chosen: boolean;
}>;

const wholeSeconds = (fromMs: number, toMs: number): number =>
	Math.max(0, Math.floor((toMs - fromMs) / 1000));

const longest = (values: readonly number[]): number =>
	values.reduce((most, value) => Math.max(most, value), 0);

/**
 * The evidence for exactly `label`: only jobs that asked for that one label
 * count, compared without case.
 */
export function queueEvidence(
	jobs: readonly QueueJob[],
	label: string,
	nowMs: number,
): QueueEvidence {
	const wanted = label.toLowerCase();
	const asking = jobs.filter(
		(job) => job.labels.length === 1 && job.labels[0]?.toLowerCase() === wanted,
	);
	const waits = asking
		.filter((job) => job.startedAtMs === undefined)
		.filter((job) => nowMs - job.createdAtMs < QUEUE_STALE_WAIT_MS)
		.map((job) => wholeSeconds(job.createdAtMs, nowMs));
	const takenWithin = (windowMs: number): readonly QueueJob[] =>
		asking.filter(
			(job) =>
				job.startedAtMs !== undefined &&
				wholeSeconds(job.startedAtMs, nowMs) <= windowMs / 1000,
		);
	const pickupSeconds = (job: QueueJob): number =>
		wholeSeconds(job.createdAtMs, job.startedAtMs ?? job.createdAtMs);
	return {
		waiting: waits.length,
		oldestWaitSeconds: longest(waits),
		recentPickups: takenWithin(QUEUE_RECENT_PICKUP_MS).length,
		slowestRecentPickupSeconds: longest(
			takenWithin(QUEUE_SLOW_PICKUP_MEMORY_MS).map(pickupSeconds),
		),
		lastPickupAtMs: longest(asking.map((job) => job.startedAtMs ?? 0)),
	};
}

/**
 * A label is refusing jobs when one has waited for it past the limit, a
 * recent pickup was that slow, or as many jobs as the limit already wait.
 */
export function refusingJobs(
	evidence: QueueEvidence,
	limits: QueueLimits = DEFAULT_QUEUE_LIMITS,
): boolean {
	return (
		evidence.oldestWaitSeconds >= limits.maxWaitSeconds ||
		evidence.slowestRecentPickupSeconds >= limits.maxWaitSeconds ||
		evidence.waiting >= limits.maxQueued
	);
}

/**
 * A label is taking jobs when a runner was seen to take one recently and
 * nothing says it is refusing them. An empty queue alone says nothing.
 */
export function takingJobs(
	evidence: QueueEvidence,
	limits: QueueLimits = DEFAULT_QUEUE_LIMITS,
): boolean {
	return evidence.recentPickups > 0 && !refusingJobs(evidence, limits);
}

const timeMs = (text: string | null | undefined): number =>
	Date.parse(text ?? "");

const RunsPage = z.object({
	workflow_runs: z.array(
		z.object({
			id: z.number(),
			status: z.string().nullish(),
			path: z.string().nullish(),
			created_at: z.string().nullish(),
			updated_at: z.string().nullish(),
		}),
	),
});

const JobsPage = z.object({
	jobs: z.array(
		z.object({
			run_id: z.number(),
			status: z.string().nullish(),
			labels: z.array(z.string()).nullish(),
			created_at: z.string().nullish(),
			started_at: z.string().nullish(),
			runner_name: z.string().nullish(),
		}),
	),
});

type JsonInput = z.infer<ReturnType<typeof z.json>>;

/** The runs on one page of `GET /actions/runs`, or nothing when it is not one. */
export function queueRunsOf(body: JsonInput): readonly QueueRun[] | undefined {
	const page = RunsPage.safeParse(body);
	if (!page.success) return undefined;
	return page.data.workflow_runs.map((run) => ({
		id: run.id,
		createdAtMs: timeMs(run.created_at),
		updatedAtMs: timeMs(run.updated_at),
		finished: run.status === "completed",
		probe: run.path === QUEUE_PROBE_WORKFLOW_PATH,
	}));
}

/**
 * Statuses of a job still waiting for a runner. `pending` is left out: GitHub
 * uses it for a job held by a concurrency group, which waits on another run.
 */
const WAITING_STATUSES: ReadonlySet<string> = new Set(["queued"]);

/**
 * The jobs on one page of `GET /actions/runs/{id}/jobs`, or nothing when it
 * is not one. A job skipped, cancelled or held by a concurrency group before a
 * runner took it is left out.
 */
export function queueJobsOf(body: JsonInput): QueueJobsPage | undefined {
	const page = JobsPage.safeParse(body);
	if (!page.success) return undefined;
	const jobs = page.data.jobs.flatMap((job): QueueJob[] => {
		const createdAtMs = timeMs(job.created_at);
		if (Number.isNaN(createdAtMs)) return [];
		const labels = job.labels ?? [];
		// Status first, as the route job reads it: a re-queued job may still
		// name the runner that last had it.
		if (WAITING_STATUSES.has(job.status ?? ""))
			return [
				{ runId: job.run_id, labels, createdAtMs, startedAtMs: undefined },
			];
		const startedAtMs = timeMs(job.started_at);
		if (job.runner_name && !Number.isNaN(startedAtMs))
			return [{ runId: job.run_id, labels, createdAtMs, startedAtMs }];
		return [];
	});
	return {
		jobs,
		chosen: page.data.jobs.some((job) => job.status === "completed"),
	};
}

/**
 * Unfinished runs that started up to `QUEUE_BURST_MS` before this one,
 * newest first. Each may be about to take the runner this run is weighing.
 */
export function runsJustAhead(
	runs: readonly QueueRun[],
	ownRunId: number,
	nowMs: number,
): readonly number[] {
	const own = runs.find((run) => run.id === ownRunId);
	const ownCreatedAtMs =
		own && !Number.isNaN(own.createdAtMs) ? own.createdAtMs : nowMs;
	return runs
		.filter(
			(run) =>
				!run.finished &&
				!run.probe &&
				run.id < ownRunId &&
				ownCreatedAtMs - run.createdAtMs <= QUEUE_BURST_MS,
		)
		.map((run) => run.id)
		.sort((left, right) => right - left);
}

/** Oldest and newest alternately: old runs show long waits, new ones a queue filling up. */
function alternateEnds(ids: readonly number[]): readonly number[] {
	const ordered: number[] = [];
	for (let low = 0, high = ids.length - 1; low <= high; low++, high--) {
		ordered.push(ids[low] ?? 0);
		if (high > low) ordered.push(ids[high] ?? 0);
	}
	return ordered;
}

/**
 * Which runs' job lists to read, in order, at most `max`: the newest probe
 * runs, the finished runs that took longest within the slow-pickup memory,
 * the runs just ahead of this one, then the other unfinished runs, oldest and
 * newest alternately. This run itself is left out: its jobs wait on it.
 */
export function runsToRead(
	runs: readonly QueueRun[],
	ownRunId: number,
	nowMs: number,
	max: number,
): readonly number[] {
	const others = runs.filter((run) => run.id !== ownRunId);
	const probes = others
		.filter((run) => run.probe)
		.map((run) => run.id)
		.sort((left, right) => right - left)
		.slice(0, QUEUE_MAX_PROBE_RUNS);
	const slowest = others
		.filter(
			(run) =>
				run.finished &&
				!run.probe &&
				nowMs - run.updatedAtMs <= QUEUE_SLOW_PICKUP_MEMORY_MS &&
				run.updatedAtMs >= run.createdAtMs,
		)
		.sort(
			(left, right) =>
				right.updatedAtMs -
				right.createdAtMs -
				(left.updatedAtMs - left.createdAtMs),
		)
		.map((run) => run.id)
		.slice(0, QUEUE_MAX_FINISHED_RUNS);
	const ahead = runsJustAhead(runs, ownRunId, nowMs);
	const rest = others
		.filter((run) => !run.finished && !run.probe && !ahead.includes(run.id))
		.map((run) => run.id)
		.sort((left, right) => left - right);
	const ordered: number[] = [];
	for (const id of [...probes, ...slowest, ...ahead, ...alternateEnds(rest)])
		if (!ordered.includes(id)) ordered.push(id);
	return ordered.slice(0, Math.max(0, max));
}
