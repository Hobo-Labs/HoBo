#!/usr/bin/env node
/**
 * Picks the runner a workflow run's jobs ask for: the hobo fleet while it is
 * taking jobs, a local box when one is enrolled and the fleet is not, and
 * GitHub's own machines when neither is.
 *
 * Runs first in every workflow, on a GitHub-hosted machine, so the choice does
 * not itself wait on the fleet. It has no dependencies and installs nothing.
 *
 * Without a slip, availability is read from GitHub's queue, the one thing every backend
 * shares: a backend is taking jobs when it was seen to pick one up recently and
 * quickly, no job asking for its label has waited past the limit, and few jobs
 * are already waiting for it. Nothing is asked of the fleet itself,
 * so a fleet that is down, saturated, or cut off from its relay reads the same.
 *
 * The relay decides first, when it has said anything (ADR-0181):
 * the box relay writes a routing slip to `refs/hobo/routing-slip`, and this
 * script reads it once (`GET /git/ref`, then `GET /git/commits`, three
 * seconds together, with the job's own token). A slip that has not expired,
 * names this repository and names only labels `.hobo/ci.json`'s
 * `runnerRouting.labels` allows decides the run's class (`pr`, `fork` or
 * `trunk`), and nothing else is read. With no usable slip the queue decides
 * at once, exactly as it did before slips (rule R3), and a titled warning
 * (`hobo-ci-route-fallback`) says why.
 *
 * Every setting comes from `runnerRouting` in `.hobo/ci.json` (the pin, the
 * queue limits, the labels, whether a local box is enrolled), read with the
 * dependency-free reader `runner-routing.mts`; the code defaults stand in
 * when the file holds none. What a caller chooses for one run (`--route`,
 * `--include-own-run`, `--attested`) arrives as arguments. No environment
 * variable carries routing (rule R2).
 *
 * Runs that start together would each read the same queue before any of them
 * had added to it, so a run waits its turn: while a run that started just
 * ahead has not chosen, this one leaves the self-hosted runners to it.
 *
 * A run can ask again later (`--include-own-run true`): the main gate's plan
 * job does, before its shards. It reads the slip again, which may have
 * changed; without one, the queue reading keeps the run's own jobs, which by
 * then are the freshest evidence there is: a plan job that itself waited past
 * the limit takes the fleet out of the decision.
 *
 * Every decision prints one `hobo-ci-route` notice (`routeAnnotation`) that a
 * monitor reads from the job's check run.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_GITHUB_MACHINE_TYPE,
	type FleetMember,
	LOCAL_HOST_RUNNER_LABEL,
	selectFleetBackend,
} from "../../packages/ci/src/fleet-overflow.ts";
import {
	judgeRoutingSlip,
	type ParsedRoutingSlip,
	type RoutingSlipClassName,
	type RoutingSlipRefusal,
	RUNNER_ROUTING_PATH,
	type RunnerRouting,
	readRoutingSlip,
	readRunnerRouting,
	routingLabels,
} from "./runner-routing.mts";

/** `auto` falls back; the others pin one tier, `fleet` being the behaviour before routing. */
export const ROUTE_MODES = ["auto", "fleet", "local", "github"] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/**
 * How long a run that has started may go without choosing a runner before it
 * is taken to have chosen. The route job is the first thing a run does and
 * takes seconds; a run older than this that still shows no finished job is
 * stuck somewhere else.
 */
export const BURST_SECONDS = 60;
/** The workflow whose only work is to be picked up by each self-hosted label. */
export const PROBE_WORKFLOW_PATH = ".github/workflows/fleet-probe.yml";
/** Probe runs read per decision: the newest may still be waiting, the ones before it say how the last went. */
export const MAX_PROBE_LOOKUPS = 3;

/**
 * How long a run waits for a probe that is under way before it gives up on a
 * backend no runner has been seen on. Only a run with nothing else to go on
 * waits: after a quiet spell the fleet is still used if it answers.
 */
export const PROBE_WAIT_SECONDS = 60;
export const PROBE_POLL_SECONDS = 10;

export type RouteTier = "fleet" | "local" | "github";

/** A job has waited this long for a label: that backend is not taking jobs. */
export const DEFAULT_MAX_WAIT_SECONDS = 120;
/**
 * This many jobs already waiting for a label: a new run's jobs would queue
 * behind them. The fleet's box has two slots, so four waiting is two rounds.
 */
export const DEFAULT_MAX_QUEUED = 4;
/** How far back a started job still says how quickly the backend picks jobs up. */
export const RECENT_PICKUP_SECONDS = 15 * 60;
/** A job queued this long was abandoned, not kept waiting; it says nothing about now. */
export const STALE_WAIT_SECONDS = 24 * 60 * 60;
/** Job lists read per decision, split between the oldest and the newest unfinished runs. */
export const MAX_RUN_LOOKUPS = 8;
/**
 * How long a slow pickup counts against a backend. Longer than the window a
 * pickup counts for it: the probe is one small job, and a runner taking it at
 * once says the label is alive, not that it can take a run. A run sent to the
 * fleet on that alone waited 17 minutes for runners. A real job that waited
 * past the limit keeps the backend out for this long, so a fleet that cannot
 * keep up is tried once in the hour, not by every run that finds it idle.
 */
export const SLOW_PICKUP_MEMORY_SECONDS = 60 * 60;
/**
 * Finished runs read per decision, the longest-running first. A slow backend
 * shows in the runs it slowed down, and once those finish they are no longer
 * among the unfinished runs this reads.
 */
export const MAX_FINISHED_LOOKUPS = 3;

/** A job seen in the queue; `startedAtMs` is set once a runner has taken it. */
export type SeenJob = Readonly<{
	runId: number;
	labels: readonly string[];
	createdAtMs: number;
	startedAtMs?: number;
}>;

export type RouteLimits = Readonly<{
	maxWaitSeconds: number;
	maxQueued: number;
}>;

/** What the queue shows for one label. */
export type LabelLoad = Readonly<{
	queued: number;
	oldestWaitSeconds: number;
	/** Jobs a runner took within the recent window. */
	recentPickups: number;
	slowestRecentPickupSeconds: number;
}>;

/** What took the fleet out of a decision: the relay's slip, the queue, or nothing. */
export type RefusedBy = "slip" | "queue" | "none";

/**
 * What became of the routing slip for this decision. `used`: it decided, for
 * the relay's `reason`. `fallback`: none could be used, for `why`, and the
 * queue decided. `unasked`: the tier is pinned or a signed local run covers
 * the tree, so no slip was read.
 */
export type SlipAnswer =
	| Readonly<{ kind: "used"; reason: string; from: string }>
	| Readonly<{ kind: "fallback"; why: string }>
	| Readonly<{ kind: "unasked"; why: UnaskedWhy }>;

export type RouteDecision = Readonly<{
	tier: RouteTier;
	runner: string;
	reason: string;
	/** Left out where nothing could have refused the fleet (a pinned tier). */
	refusedBy?: RefusedBy | undefined;
	/** What became of the routing slip; left out by the queue rule alone. */
	slip?: SlipAnswer | undefined;
}>;

const seconds = (fromMs: number, toMs: number) =>
	Math.max(0, Math.floor((toMs - fromMs) / 1000));

/**
 * The load on exactly `label`: jobs still waiting (ignoring abandoned ones)
 * and how long the jobs a runner took recently had to wait.
 */
export function labelLoad(
	jobs: readonly SeenJob[],
	label: string,
	nowMs: number,
): LabelLoad {
	const asking = jobs.filter(
		(job) => job.labels.length === 1 && job.labels[0]?.toLowerCase() === label,
	);
	const waits = asking
		.filter((job) => job.startedAtMs === undefined)
		.map((job) => seconds(job.createdAtMs, nowMs))
		.filter((wait) => wait < STALE_WAIT_SECONDS);
	const pickedUpWithin = (window: number) =>
		asking.flatMap((job) =>
			job.startedAtMs !== undefined && seconds(job.startedAtMs, nowMs) <= window
				? [seconds(job.createdAtMs, job.startedAtMs)]
				: [],
		);
	const longest = (values: readonly number[]) =>
		values.reduce((most, value) => Math.max(most, value), 0);
	return {
		queued: waits.length,
		oldestWaitSeconds: longest(waits),
		recentPickups: pickedUpWithin(RECENT_PICKUP_SECONDS).length,
		slowestRecentPickupSeconds: longest(
			pickedUpWithin(SLOW_PICKUP_MEMORY_SECONDS),
		),
	};
}

/**
 * A backend is refusing jobs when one has waited for it past the limit, it was
 * slow to pick one up within the slow-pickup memory, or as many jobs as the
 * limit are already waiting. The last is what a wait alone misses: a queue that was just
 * emptied and refilled is full long before its oldest job is old.
 */
export function refusingJobs(load: LabelLoad, limits: RouteLimits): boolean {
	return (
		load.oldestWaitSeconds >= limits.maxWaitSeconds ||
		load.slowestRecentPickupSeconds >= limits.maxWaitSeconds ||
		load.queued >= limits.maxQueued
	);
}

/**
 * A backend is taking jobs when it has been seen to: a runner took a job
 * recently, and nothing says it is refusing them.
 *
 * Being seen to matters most. An empty queue says nothing: when the merge
 * queue was rebuilt, ten runs chose in the same second, each saw nothing
 * waiting for the fleet, and all ten were sent to a fleet that was taking
 * minutes to pick a job up. Without a recent pickup the answer is no, and the
 * run goes where jobs are known to start. The probe workflow keeps a pickup
 * on record while the backend is up.
 */
export function takingJobs(load: LabelLoad, limits: RouteLimits): boolean {
	return load.recentPickups > 0 && !refusingJobs(load, limits);
}

export function parseRouteMode(value: string | undefined): RouteMode {
	const mode = ROUTE_MODES.find((candidate) => candidate === value?.trim());
	return mode ?? "auto";
}

function describeLoad(name: string, load: LabelLoad): string {
	const waiting =
		load.queued === 0
			? `${name} has nothing waiting`
			: `${name} has ${load.queued} waiting, the oldest for ${load.oldestWaitSeconds} s`;
	return load.recentPickups === 0
		? `${waiting}, and has not been seen to pick a job up in the last ${RECENT_PICKUP_SECONDS / 60} minutes`
		: `${waiting}, and in the last ${SLOW_PICKUP_MEMORY_SECONDS / 60} minutes took up to ${load.slowestRecentPickupSeconds} s to pick a job up`;
}

/**
 * The decision, from what the queue shows: the queue rule, which decides
 * whenever no routing slip can (R3). `fleetLabel` is the label this run would
 * ask the fleet for (`hobo`, or `hobo-trunk` for trunk events); `localLabel`
 * and `githubLabel` are the committed `runnerRouting.labels`, the code's
 * defaults when left out.
 */
export function routeRunner(input: {
	mode: RouteMode;
	fleetLabel: string;
	localLabel?: string | undefined;
	githubLabel?: string | undefined;
	localEnrolled: boolean;
	limits: RouteLimits;
	fleet: LabelLoad;
	local: LabelLoad;
	/** Runs that started just ahead of this one and have not chosen a runner yet. */
	undecidedAhead: number;
}): RouteDecision {
	const { mode, fleetLabel, limits } = input;
	const localLabel = input.localLabel ?? LOCAL_HOST_RUNNER_LABEL;
	const githubLabel = input.githubLabel ?? DEFAULT_GITHUB_MACHINE_TYPE;
	if (mode === "fleet")
		return {
			tier: "fleet",
			runner: fleetLabel,
			reason: "routing is pinned to the fleet",
		};
	if (mode === "github")
		return {
			tier: "github",
			runner: githubLabel,
			reason: "routing is pinned to GitHub-hosted runners",
		};
	if (mode === "local")
		return {
			tier: "local",
			runner: localLabel,
			reason: "routing is pinned to the local box",
		};
	// A run that has not chosen yet is taken to choose a self-hosted runner.
	// Its jobs are not in the queue to be counted, and runs that start together
	// would otherwise all read the same empty queue and all choose the fleet.
	const first = input.undecidedAhead === 0;
	const members = [
		{
			id: "fleet",
			backend: "hobo",
			enabled: true,
			runsOn: fleetLabel,
			freeSlots: first && takingJobs(input.fleet, limits) ? 1 : 0,
		},
		{
			id: "local",
			backend: "local",
			enabled: input.localEnrolled,
			runsOn: localLabel,
			freeSlots: first && takingJobs(input.local, limits) ? 1 : 0,
		},
		{
			id: "github",
			backend: "github",
			enabled: true,
			runsOn: githubLabel,
			freeSlots: 1,
		},
	] satisfies FleetMember[];
	const selected = selectFleetBackend({ members, currentLabels: [] });
	const loads = [
		describeLoad("the fleet", input.fleet),
		input.localEnrolled
			? describeLoad("the local box", input.local)
			: "no local box is enrolled",
		...(first
			? []
			: [
					`${input.undecidedAhead} run(s) started in the ${BURST_SECONDS} s before this one and have not chosen a runner yet`,
				]),
	].join("; ");
	if (!selected || selected.backend === "hobo")
		return {
			tier: "fleet",
			runner: fleetLabel,
			reason: loads,
			refusedBy: "none",
		};
	return {
		tier: selected.backend === "local" ? "local" : "github",
		runner: selected.runsOn,
		reason: `${loads}; the limits are ${limits.maxWaitSeconds} s and ${limits.maxQueued} waiting`,
		refusedBy: "queue",
	};
}

/** A parsed JSON document: what GitHub answers with. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

function asObject(value: JsonValue | undefined): JsonObject | undefined {
	// SAFETY: the tag check proves a plain object, which JSON.parse only produces as a JsonObject.
	return tagOf.call(value) === "[object Object]"
		? (value as JsonObject)
		: undefined;
}
function asText(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive.
	return tagOf.call(value) === "[object String]"
		? (value as string)
		: undefined;
}
function asNumber(value: JsonValue | undefined): number | undefined {
	// SAFETY: the tag check proves a number primitive.
	return tagOf.call(value) === "[object Number]"
		? (value as number)
		: undefined;
}
function asList(value: JsonValue | undefined): readonly JsonValue[] {
	return Array.isArray(value) ? value : [];
}

type ListedRun = Readonly<{
	id: number;
	createdAtMs: number;
	/** When the run last changed; for a finished run, when it finished. */
	updatedAtMs: number;
	finished: boolean;
	probe: boolean;
}>;

function listedRuns(runsPage: JsonValue): ListedRun[] {
	return asList(asObject(runsPage)?.workflow_runs).flatMap((entry) => {
		const run = asObject(entry);
		const id = asNumber(run?.id);
		if (!run || id === undefined) return [];
		return [
			{
				id,
				createdAtMs: Date.parse(asText(run.created_at) ?? ""),
				updatedAtMs: Date.parse(asText(run.updated_at) ?? ""),
				finished: asText(run.status) === "completed",
				probe: asText(run.path) === PROBE_WORKFLOW_PATH,
			},
		];
	});
}

/**
 * Runs GitHub has not finished, oldest first, from one page of the unfiltered
 * list. Probe runs are left out: they are read on their own, finished or not.
 */
export function unfinishedRunIds(
	runsPage: JsonValue,
	ownRunId: number,
): number[] {
	return listedRuns(runsPage)
		.filter((run) => !run.finished && !run.probe && run.id !== ownRunId)
		.map((run) => run.id)
		.sort((left, right) => left - right);
}

/** The newest probe runs on the page, newest first, whatever their state. */
export function probeRunIds(runsPage: JsonValue): number[] {
	return listedRuns(runsPage)
		.filter((run) => run.probe)
		.map((run) => run.id)
		.sort((left, right) => right - left)
		.slice(0, MAX_PROBE_LOOKUPS);
}

/**
 * Runs that finished within the slow-pickup memory, the longest-running
 * first. Which runner a run used is not in the run list, but a run a slow
 * backend held up is one that took long.
 */
export function slowestFinishedRunIds(
	runsPage: JsonValue,
	ownRunId: number,
	nowMs: number,
): number[] {
	return listedRuns(runsPage)
		.filter(
			(run) =>
				run.finished &&
				!run.probe &&
				run.id !== ownRunId &&
				nowMs - run.updatedAtMs <= SLOW_PICKUP_MEMORY_SECONDS * 1000 &&
				run.updatedAtMs >= run.createdAtMs,
		)
		.sort(
			(left, right) =>
				right.updatedAtMs -
				right.createdAtMs -
				(left.updatedAtMs - left.createdAtMs),
		)
		.map((run) => run.id)
		.slice(0, MAX_FINISHED_LOOKUPS);
}

/**
 * Unfinished runs that started in the moments before this one, newest first.
 * Each may be about to put its jobs on the same runners this run is weighing.
 */
export function runsJustAhead(
	runsPage: JsonValue,
	ownRunId: number,
	nowMs: number,
): number[] {
	const runs = listedRuns(runsPage);
	const own = runs.find((run) => run.id === ownRunId);
	const ownCreatedAtMs =
		own && !Number.isNaN(own.createdAtMs) ? own.createdAtMs : nowMs;
	return runs
		.filter(
			(run) =>
				!run.finished &&
				!run.probe &&
				run.id < ownRunId &&
				ownCreatedAtMs - run.createdAtMs <= BURST_SECONDS * 1000,
		)
		.map((run) => run.id)
		.sort((left, right) => right - left);
}

/**
 * Whether a run has chosen its runner. The route job is the first to finish
 * in a routed run, and the jobs that need it appear straight after; a run
 * with no finished job has not got that far.
 */
export function hasChosen(jobsPage: JsonValue): boolean {
	return asList(asObject(jobsPage)?.jobs).some(
		(job) => asText(asObject(job)?.status) === "completed",
	);
}

/**
 * The jobs on one page of a run's job list that say something about a
 * backend: those still queued, and those a runner has taken.
 */
export function seenJobs(jobsPage: JsonValue): SeenJob[] {
	return asList(asObject(jobsPage)?.jobs).flatMap((entry) => {
		const job = asObject(entry);
		const createdAtMs = Date.parse(asText(job?.created_at) ?? "");
		const runId = asNumber(job?.run_id);
		if (!job || runId === undefined || Number.isNaN(createdAtMs)) return [];
		const labels = asList(job.labels).flatMap((label) => asText(label) ?? []);
		if (asText(job.status) === "queued")
			return [{ runId, labels, createdAtMs }];
		const startedAtMs = Date.parse(asText(job.started_at) ?? "");
		// A job that was skipped or cancelled before it ran never had a runner.
		if (!asText(job.runner_name) || Number.isNaN(startedAtMs)) return [];
		return [{ runId, labels, createdAtMs, startedAtMs }];
	});
}

/** Oldest and newest alternately: old runs show long waits, new ones a queue filling up. */
export function lookupOrder(runIds: readonly number[]): number[] {
	const ordered: number[] = [];
	for (let low = 0, high = runIds.length - 1; low <= high; low++, high--) {
		ordered.push(runIds[low] ?? 0);
		if (high > low) ordered.push(runIds[high] ?? 0);
	}
	return ordered;
}

export type QueueReader = (path: string) => Promise<JsonValue>;

export type QueueView = Readonly<{
	jobs: readonly SeenJob[];
	/** Runs just ahead of this one that have not chosen a runner, or could not be read in time. */
	undecidedAhead: number;
	/** A probe run has not finished, so a pickup may be about to be recorded. */
	probeUnderway: boolean;
}>;

/**
 * Reads the queue: the newest probe runs, the finished runs that took
 * longest, then the runs that started just ahead of this one, then the rest
 * of the unfinished runs until every label
 * is seen refusing jobs or the lookups run out. The unfiltered run list is
 * used because the status-filtered one has gone on reporting no runs while
 * runs were queued.
 */
export async function observeQueue(input: {
	read: QueueReader;
	repository: string;
	ownRunId: number;
	labels: readonly string[];
	limits: RouteLimits;
	nowMs: number;
	/**
	 * Read this run's own jobs first. The route job leaves its run out: at that
	 * moment the run has queued nothing. A job asking again later in the run
	 * (the main gate's plan job, before its shards) has no fresher evidence
	 * than how long the run's own jobs have waited.
	 */
	includeOwnRun?: boolean | undefined;
}): Promise<QueueView> {
	const runsPage = await input.read(
		`/repos/${input.repository}/actions/runs?per_page=100`,
	);
	const jobsOf = (runId: number) =>
		input.read(
			`/repos/${input.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
		);
	const seen: SeenJob[] = [];
	for (const runId of [
		...(input.includeOwnRun ? [input.ownRunId] : []),
		...probeRunIds(runsPage),
		...slowestFinishedRunIds(runsPage, input.ownRunId, input.nowMs),
	])
		seen.push(...seenJobs(await jobsOf(runId)));
	const ahead = runsJustAhead(runsPage, input.ownRunId, input.nowMs);
	const rest = lookupOrder(
		unfinishedRunIds(runsPage, input.ownRunId).filter(
			(runId) => !ahead.includes(runId),
		),
	);
	let undecidedAhead = ahead.length;
	for (const runId of [...ahead, ...rest].slice(0, MAX_RUN_LOOKUPS)) {
		const allRefusing = input.labels.every((label) =>
			refusingJobs(labelLoad(seen, label, input.nowMs), input.limits),
		);
		if (allRefusing) break;
		const jobsPage = await jobsOf(runId);
		seen.push(...seenJobs(jobsPage));
		if (ahead.includes(runId) && hasChosen(jobsPage)) undecidedAhead -= 1;
	}
	return {
		jobs: seen,
		undecidedAhead,
		probeUnderway: listedRuns(runsPage).some(
			(run) => run.probe && !run.finished,
		),
	};
}

/**
 * Decides by the queue rule, and where a probe might still change the
 * answer, waits for it.
 *
 * A wait is worth it only for a backend that is preferred to the one chosen,
 * that no runner has been seen on, and that nothing says is refusing jobs,
 * while a probe is under way and no run ahead has yet to choose. Every other
 * case is decided at once.
 */
export async function chooseRunner(input: {
	observe: (nowMs: number) => Promise<QueueView>;
	now: () => number;
	sleep: (seconds: number) => Promise<void>;
	mode: RouteMode;
	fleetLabel: string;
	localLabel?: string | undefined;
	githubLabel?: string | undefined;
	localEnrolled: boolean;
	limits: RouteLimits;
}): Promise<RouteDecision> {
	const { fleetLabel, localEnrolled, limits } = input;
	const localLabel = input.localLabel ?? LOCAL_HOST_RUNNER_LABEL;
	const startMs = input.now();
	for (;;) {
		const nowMs = input.now();
		const view = await input.observe(nowMs);
		const fleet = labelLoad(view.jobs, fleetLabel, nowMs);
		const local = labelLoad(view.jobs, localLabel, nowMs);
		const decision = routeRunner({
			mode: input.mode,
			fleetLabel,
			localLabel,
			githubLabel: input.githubLabel,
			localEnrolled,
			limits,
			fleet,
			local,
			undecidedAhead: view.undecidedAhead,
		});
		const unseen = (load: LabelLoad) =>
			load.recentPickups === 0 && !refusingJobs(load, limits);
		const probeMayHelp =
			view.probeUnderway &&
			view.undecidedAhead === 0 &&
			((decision.tier !== "fleet" && unseen(fleet)) ||
				(decision.tier === "github" && localEnrolled && unseen(local)));
		const waitedSeconds = seconds(startMs, nowMs);
		if (!probeMayHelp) return decision;
		if (waitedSeconds + PROBE_POLL_SECONDS > PROBE_WAIT_SECONDS)
			return {
				...decision,
				reason: `${decision.reason}; waited ${waitedSeconds} s for the probe to be picked up`,
			};
		await input.sleep(PROBE_POLL_SECONDS);
	}
}

function githubReader(apiUrl: string, token: string): QueueReader {
	return async (path) => {
		const response = await fetch(`${apiUrl}${path}`, {
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			},
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
		// SAFETY: a JSON document is a JsonValue by construction.
		return (await response.json()) as JsonValue;
	};
}

/** The events whose jobs ask for the trunk label; their class is `trunk`. */
export const TRUNK_EVENTS: ReadonlySet<string> = new Set([
	"push",
	"workflow_dispatch",
	"merge_group",
	"workflow_run",
]);

/** The labels the code holds, for a `.hobo/ci.json` with no `runnerRouting`. */
export const DEFAULT_RUNNER_LABELS: RunnerRouting["labels"] = {
	fleet: "hobo",
	trunk: "hobo-trunk",
	local: LOCAL_HOST_RUNNER_LABEL,
	github: DEFAULT_GITHUB_MACHINE_TYPE,
	box: "hobo-box",
};
/** No local box is enrolled unless committed configuration says so. */
export const DEFAULT_LOCAL_RUNNER = false;
/** Pull requests' deps-image job keeps the fleet label unless committed configuration says so. */
export const DEFAULT_BOX_RUNNER = false;

/** What the route job takes from `runnerRouting`, or the code's defaults. */
export type RouteSettings = Readonly<{
	pin: RouteMode;
	limits: RouteLimits;
	labels: RunnerRouting["labels"];
	localRunner: boolean;
	/**
	 * The label pull requests' deps-image job asks for (`box_runner`):
	 * `labels.box` when `runnerRouting.boxRunner` is on, else empty, and the
	 * job keeps the fleet label.
	 */
	boxRunner: string;
	/** `false` when `.hobo/ci.json` held no valid `runnerRouting`. */
	committed: boolean;
}>;

export function routeSettings(
	policy: RunnerRouting | undefined,
): RouteSettings {
	if (policy)
		return {
			pin: policy.pin,
			limits: policy.queue,
			labels: policy.labels,
			localRunner: policy.localRunner,
			boxRunner: policy.boxRunner ? policy.labels.box : "",
			committed: true,
		};
	return {
		pin: "auto",
		limits: {
			maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
			maxQueued: DEFAULT_MAX_QUEUED,
		},
		labels: DEFAULT_RUNNER_LABELS,
		localRunner: DEFAULT_LOCAL_RUNNER,
		boxRunner: DEFAULT_BOX_RUNNER ? DEFAULT_RUNNER_LABELS.box : "",
		committed: false,
	};
}

/** The label this run asks the fleet for: the trunk label for trunk events. */
export function fleetLabelFor(
	event: string,
	labels: RunnerRouting["labels"] = DEFAULT_RUNNER_LABELS,
): string {
	return TRUNK_EVENTS.has(event) ? labels.trunk : labels.fleet;
}

/** What the caller chose for this one run, passed as arguments (never as environment). */
export type RouteArgs = Readonly<{
	route: RouteMode;
	includeOwnRun: boolean;
	attested: boolean;
}>;

/**
 * `--route <auto|fleet|local|github>`, `--include-own-run <true|false>` and
 * `--attested <true|false>`, each also as `--name=value`. Anything else is
 * an error, so the action's fallback says the script did not run.
 */
export function parseRouteArgs(argv: readonly string[]): RouteArgs {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const match = /^--(route|include-own-run|attested)(?:=(.*))?$/u.exec(arg);
		if (!match?.[1]) throw new Error(`unknown argument ${arg}`);
		const value = match[2] ?? argv[(index += 1)];
		if (value === undefined) throw new Error(`${arg} needs a value`);
		values.set(match[1], value);
	}
	return {
		route: parseRouteMode(values.get("route")),
		includeOwnRun: values.get("include-own-run") === "true",
		attested: values.get("attested") === "true",
	};
}

/**
 * The slip class of this run: `trunk` for trunk events, `fork` for a pull
 * request whose head is another repository (never the trunk label), else `pr`.
 */
export function routeClass(
	event: string,
	payload: JsonValue | undefined,
): RoutingSlipClassName {
	if (TRUNK_EVENTS.has(event)) return "trunk";
	const pullRequest = asObject(asObject(payload)?.pull_request);
	if (!pullRequest) return "pr";
	const repo = (side: string) =>
		asText(
			asObject(asObject(asObject(pullRequest[side])?.repo))?.full_name,
		)?.toLowerCase();
	const base = repo("base");
	return base !== undefined && repo("head") !== base ? "fork" : "pr";
}

/** The fallback `why` for a slip the reader refused. */
export const SLIP_REFUSAL_WHY = {
	malformed: "slip malformed",
	"wrong-repository": "slip names another repository",
	"label-not-allowed": "slip names a label not in runnerRouting.labels",
	expired: "slip expired",
} as const satisfies Readonly<Record<RoutingSlipRefusal, string>>;
/** The fallback `why` when the relay has written no slip. */
export const NO_ROUTING_SLIP = "no routing slip";
/** The fallbacks that mean no current slip exists, rather than one that could not be used. */
export const ABSENT_SLIP_WHYS: readonly string[] = [
	NO_ROUTING_SLIP,
	SLIP_REFUSAL_WHY.expired,
];

/** The decision a usable slip makes for this run's class. */
export function slipDecision(
	slip: ParsedRoutingSlip,
	routeClassName: RoutingSlipClassName,
): RouteDecision {
	const route = slip.classes[routeClassName];
	const from = `${slip.relay.nodeId}@${slip.relay.commit}`;
	return {
		tier: route.tier,
		runner: route.runner,
		reason: `relay: slip from ${from}, ${route.reason}`,
		refusedBy: route.tier === "fleet" ? "none" : "slip",
		slip: { kind: "used", reason: route.reason, from },
	};
}

export type SlipReading =
	| Readonly<{ ok: true; decision: RouteDecision }>
	| Readonly<{ ok: false; why: string }>;

/**
 * Reads the slip once and judges it: the decision it makes, or why there is
 * none. Never throws, and takes at most the reader's three seconds.
 */
export async function askSlip(input: {
	apiUrl: string;
	repository: string;
	token: string;
	labels: RunnerRouting["labels"];
	routeClass: RoutingSlipClassName;
	nowMs: () => number;
	fetch?: typeof fetch | undefined;
}): Promise<SlipReading> {
	const read = await readRoutingSlip({
		apiUrl: input.apiUrl,
		repository: input.repository,
		token: input.token,
		fetch: input.fetch,
	});
	if (read.kind === "none") return { ok: false, why: read.why };
	const judged = judgeRoutingSlip(read.text, {
		repository: input.repository,
		nowMs: input.nowMs(),
		labels: routingLabels({ labels: input.labels }),
	});
	return judged.ok
		? { ok: true, decision: slipDecision(judged.slip, input.routeClass) }
		: { ok: false, why: SLIP_REFUSAL_WHY[judged.why] };
}

/** A file from the checkout, or nothing when it is not there. */
function readCheckoutFile(
	env: NodeJS.ProcessEnv,
	path: string,
): string | undefined {
	try {
		return readFileSync(
			join(env.GITHUB_WORKSPACE ?? process.cwd(), path),
			"utf8",
		);
	} catch {
		return undefined;
	}
}

/** The event that started the run, from the file GitHub names, or nothing. */
function readEventPayload(env: NodeJS.ProcessEnv): JsonValue | undefined {
	if (!env.GITHUB_EVENT_PATH) return undefined;
	try {
		// SAFETY: a JSON document is a JsonValue by construction.
		return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as JsonValue;
	} catch {
		return undefined;
	}
}

/** Nothing seen: what a pinned tier is decided against. */
const UNREAD: LabelLoad = {
	queued: 0,
	oldestWaitSeconds: 0,
	recentPickups: 0,
	slowestRecentPickupSeconds: 0,
};

export async function main(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	io: Readonly<{
		/** The contents of `.hobo/ci.json`; read from the checkout when left out. */
		routingConfig?: string | undefined;
		/** The event payload; read from `GITHUB_EVENT_PATH` when left out. */
		eventPayload?: JsonValue | undefined;
		/** Used for the slip read only. */
		fetch?: typeof fetch;
		now?: () => number;
	}> = {},
): Promise<RouteDecision> {
	const args = parseRouteArgs(argv);
	const settings = routeSettings(
		readRunnerRouting(
			"routingConfig" in io
				? io.routingConfig
				: readCheckoutFile(env, RUNNER_ROUTING_PATH),
		),
	);
	const { labels, limits } = settings;
	// From committed policy alone, so it is written whatever the route turns out to be.
	if (env.GITHUB_OUTPUT)
		appendFileSync(env.GITHUB_OUTPUT, `box_runner=${settings.boxRunner}\n`);
	const event = env.GITHUB_EVENT_NAME ?? "";
	const fleetLabel = fleetLabelFor(event, labels);
	// A dispatch's own choice wins; otherwise the committed pin.
	const mode = args.route === "auto" ? settings.pin : args.route;
	const localEnrolled = settings.localRunner;
	const defaults = settings.committed
		? ""
		: `; ${RUNNER_ROUTING_PATH} holds no valid runnerRouting, so the code's defaults apply`;
	const now = io.now ?? Date.now;
	// A signed local run was verified for this tree, so the jobs it covers are
	// skipped and only a few short ones are left. They go where a job is known
	// to start, without reading the slip or the queue. A pinned tier is an
	// operator's own override and still wins.
	if (mode === "auto" && args.attested)
		return report(
			{
				tier: "github",
				runner: labels.github,
				reason: `a signed local run covers this tree, so the jobs left do not wait for a fleet${defaults}`,
				refusedBy: "none",
				slip: { kind: "unasked", why: "attested" },
			},
			env,
		);
	if (mode !== "auto") {
		const pinned = routeRunner({
			mode,
			fleetLabel,
			localLabel: labels.local,
			githubLabel: labels.github,
			localEnrolled,
			limits,
			fleet: UNREAD,
			local: UNREAD,
			undecidedAhead: 0,
		});
		return report(
			{
				...pinned,
				reason: `${pinned.reason}${defaults}`,
				slip: { kind: "unasked", why: "pinned" },
			},
			env,
		);
	}
	const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
	const repository = env.GITHUB_REPOSITORY ?? "";
	const token = env.GITHUB_TOKEN ?? "";
	const slip = await askSlip({
		apiUrl,
		repository,
		token,
		labels,
		routeClass: routeClass(
			event,
			"eventPayload" in io ? io.eventPayload : readEventPayload(env),
		),
		nowMs: now,
		fetch: io.fetch,
	});
	if (slip.ok)
		return report(
			{ ...slip.decision, reason: `${slip.decision.reason}${defaults}` },
			env,
		);
	// No usable slip: the queue decides at once, as it did before slips (R3).
	console.log(
		`::warning title=hobo-ci-route-fallback::${escapeCommand(`${SLIP_FALLBACK_PREFIX} (${slip.why}); the queue rule decides`)}`,
	);
	let decision: RouteDecision;
	try {
		const read = githubReader(apiUrl, token);
		decision = await chooseRunner({
			observe: (nowMs) =>
				observeQueue({
					read,
					repository,
					ownRunId: Number(env.GITHUB_RUN_ID),
					labels: localEnrolled ? [fleetLabel, labels.local] : [fleetLabel],
					limits,
					nowMs,
					includeOwnRun: args.includeOwnRun,
				}),
			now,
			sleep: (wait) => delay(wait * 1000),
			mode,
			fleetLabel,
			localLabel: labels.local,
			githubLabel: labels.github,
			localEnrolled,
			limits,
		});
	} catch (error) {
		// This job is running on a GitHub-hosted machine, so that tier is known
		// to be up; with the queue unreadable, nothing is known about the others.
		decision = {
			tier: "github",
			runner: labels.github,
			reason: `the queue could not be read (${error instanceof Error ? error.message : "unknown error"})`,
			refusedBy: "queue",
		};
	}
	return report(
		{
			...decision,
			reason: `${decision.reason}; no routing slip decided (${slip.why})${defaults}`,
			slip: { kind: "fallback", why: slip.why },
		},
		env,
	);
}

/** How a slip fallback warning starts; the monitor tells it from a route that did not run. */
export const SLIP_FALLBACK_PREFIX = "routing slip not used";

/** Why no slip was read: the tier is pinned, or a signed local run covers the tree. */
export type UnaskedWhy = "pinned" | "attested";

/** The workflow file a run belongs to, from `GITHUB_WORKFLOW_REF`. */
export function workflowFile(env: NodeJS.ProcessEnv): string {
	const path = env.GITHUB_WORKFLOW_REF?.split("@")[0] ?? "";
	return path.slice(path.lastIndexOf("/") + 1) || (env.GITHUB_WORKFLOW ?? "");
}

/** A workflow command's message ends at a newline; `%` starts an escape. */
function escapeCommand(message: string): string {
	return message
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
}

/** The route notice's record version: 2 carries the slip, 1 carried the hosted relay's verdict. */
export const ROUTE_NOTICE_VERSION = 2;

/**
 * The one-line record of a decision a monitor reads from the job's check run
 * (`::notice title=hobo-ci-route::{...}`): which tier and runner, what became
 * of the slip and why (the relay's reason when it decided, the fallback when
 * it did not), and what took the fleet out of the decision.
 */
export function routeAnnotation(
	decision: RouteDecision,
	workflow: string,
): string {
	const slip = decision.slip;
	const record = {
		v: ROUTE_NOTICE_VERSION,
		workflow,
		tier: decision.tier,
		runner: decision.runner,
		slip: slip?.kind ?? "unasked",
		why:
			slip?.kind === "used"
				? slip.reason
				: slip?.kind === "fallback" || slip?.kind === "unasked"
					? slip.why
					: "",
		refusedBy: decision.refusedBy ?? "none",
	};
	return `::notice title=hobo-ci-route::${escapeCommand(JSON.stringify(record))}`;
}

function report(
	decision: RouteDecision,
	env: NodeJS.ProcessEnv,
): RouteDecision {
	const line = `runner: ${decision.runner} (${decision.tier}): ${decision.reason}`;
	console.log(line);
	console.log(routeAnnotation(decision, workflowFile(env)));
	// The shards follow the run's class: trunk on trunk events, else the run's own.
	if (env.GITHUB_OUTPUT)
		appendFileSync(
			env.GITHUB_OUTPUT,
			`runner=${decision.runner}\ntier=${decision.tier}\nshard_runner=${decision.runner}\n`,
		);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
	return decision;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	await main(process.argv.slice(2));
