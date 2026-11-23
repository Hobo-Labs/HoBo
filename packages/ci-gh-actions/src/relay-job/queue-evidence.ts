import { z } from "zod";

export const QUEUE_RECENT_PICKUP_MS = 15 * 60_000;
export const QUEUE_SLOW_PICKUP_MEMORY_MS = 60 * 60_000;
export const QUEUE_STALE_WAIT_MS = 24 * 60 * 60_000;
export const QUEUE_BURST_MS = 60_000;
// public-contract: the probe workflow path the route job also reads first.
export const QUEUE_PROBE_WORKFLOW_PATH = ".github/workflows/fleet-probe.yml";
export const QUEUE_MAX_PROBE_RUNS = 3;
export const QUEUE_MAX_FINISHED_RUNS = 3;

export type QueueLimits = Readonly<{
	maxWaitSeconds: number;
	maxQueued: number;
}>;

// public-contract: the limits the route job uses when `runnerRouting.queue` sets none.
export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
	maxWaitSeconds: 120,
	maxQueued: 4,
};

export type QueueJob = Readonly<{
	runId: number;
	labels: readonly string[];
	createdAtMs: number;
	startedAtMs: number | undefined;
}>;

export type QueueEvidence = Readonly<{
	waiting: number;
	oldestWaitSeconds: number;
	recentPickups: number;
	slowestRecentPickupSeconds: number;
	lastPickupAtMs: number;
}>;

export type QueueRun = Readonly<{
	id: number;
	createdAtMs: number;
	updatedAtMs: number;
	finished: boolean;
	probe: boolean;
}>;

export type QueueJobsPage = Readonly<{
	jobs: readonly QueueJob[];
	chosen: boolean;
}>;

const wholeSeconds = (fromMs: number, toMs: number): number =>
	Math.max(0, Math.floor((toMs - fromMs) / 1000));

const longest = (values: readonly number[]): number =>
	values.reduce((most, value) => Math.max(most, value), 0);

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

const WAITING_STATUSES: ReadonlySet<string> = new Set(["queued"]);

export function queueJobsOf(body: JsonInput): QueueJobsPage | undefined {
	const page = JobsPage.safeParse(body);
	if (!page.success) return undefined;
	const jobs = page.data.jobs.flatMap((job): QueueJob[] => {
		const createdAtMs = timeMs(job.created_at);
		if (Number.isNaN(createdAtMs)) return [];
		const labels = job.labels ?? [];
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

function alternateEnds(ids: readonly number[]): readonly number[] {
	const ordered: number[] = [];
	for (let low = 0, high = ids.length - 1; low <= high; low++, high--) {
		ordered.push(ids[low] ?? 0);
		if (high > low) ordered.push(ids[high] ?? 0);
	}
	return ordered;
}

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
