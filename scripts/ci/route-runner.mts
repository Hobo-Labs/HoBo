#!/usr/bin/env node
/**
 * Picks the runner a workflow run's jobs ask for: the hobo fleet while it is
 * taking jobs, a local box when one is enrolled and the fleet is not, and
 * GitHub's own machines when neither is.
 *
 * Runs first in every workflow, on a GitHub-hosted machine, so the choice does
 * not itself wait on the fleet. It has no dependencies and installs nothing.
 *
 * Availability is read from GitHub's queue, the one thing every backend
 * shares: a backend is taking jobs when it was seen to pick one up recently and
 * quickly, no job asking for its label has waited past the limit, and few jobs
 * are already waiting for it. Nothing is asked of the fleet itself,
 * so a fleet that is down, saturated, or cut off from its relay reads the same.
 *
 * Runs that start together would each read the same queue before any of them
 * had added to it, so a run waits its turn: while a run that started just
 * ahead has not chosen, this one leaves the self-hosted runners to it.
 */
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	FLEET_CAPACITY_VARIABLE,
	type FleetLabelCapacity,
	fleetLabelCapacity,
	parseFleetCapacityVariable,
} from "../../packages/ci/src/fleet/capacity.ts";
import {
	DEFAULT_GITHUB_MACHINE_TYPE,
	type FleetMember,
	LOCAL_HOST_RUNNER_LABEL,
	selectFleetBackend,
} from "../../packages/ci/src/fleet-overflow.ts";

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

export type RouteDecision = Readonly<{
	tier: RouteTier;
	runner: string;
	reason: string;
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
 * The decision, from what the queue shows. `fleetLabel` is the label this run
 * would ask the fleet for (`hobo`, or `hobo-trunk` for trunk events).
 */
export function routeRunner(input: {
	mode: RouteMode;
	fleetLabel: string;
	localEnrolled: boolean;
	limits: RouteLimits;
	fleet: LabelLoad;
	local: LabelLoad;
	/** Runs that started just ahead of this one and have not chosen a runner yet. */
	undecidedAhead: number;
	/** Live box headroom from `HOBO_CI_FLEET_CAPACITY`, when published. */
	fleetCapacity?: FleetLabelCapacity;
}): RouteDecision {
	const { mode, fleetLabel, limits } = input;
	if (mode === "fleet")
		return {
			tier: "fleet",
			runner: fleetLabel,
			reason: "routing is pinned to the fleet",
		};
	if (mode === "github")
		return {
			tier: "github",
			runner: DEFAULT_GITHUB_MACHINE_TYPE,
			reason: "routing is pinned to GitHub-hosted runners",
		};
	if (mode === "local")
		return {
			tier: "local",
			runner: LOCAL_HOST_RUNNER_LABEL,
			reason: "routing is pinned to the local box",
		};
	// A run that has not chosen yet is taken to choose a self-hosted runner.
	// Its jobs are not in the queue to be counted, and runs that start together
	// would otherwise all read the same empty queue and all choose the fleet.
	const first = input.undecidedAhead === 0;
	const capacity = input.fleetCapacity;
	const fleetAdmits = capacity === undefined || capacity.admit;
	const fleetSlots =
		capacity === undefined ? 1 : Math.min(1, Math.max(0, capacity.freeSlots));
	const members = [
		{
			id: "fleet",
			backend: "hobo",
			enabled: true,
			runsOn: fleetLabel,
			freeSlots:
				first && fleetAdmits && takingJobs(input.fleet, limits)
					? fleetSlots
					: 0,
		},
		{
			id: "local",
			backend: "local",
			enabled: input.localEnrolled,
			runsOn: LOCAL_HOST_RUNNER_LABEL,
			freeSlots: first && takingJobs(input.local, limits) ? 1 : 0,
		},
		{
			id: "github",
			backend: "github",
			enabled: true,
			runsOn: DEFAULT_GITHUB_MACHINE_TYPE,
			freeSlots: 1,
		},
	] satisfies FleetMember[];
	const selected = selectFleetBackend({ members, currentLabels: [] });
	const capacityNote =
		capacity === undefined
			? "fleet capacity unset"
			: capacity.admit
				? `fleet admits ${capacity.requiredMb} MiB jobs (${capacity.freeSlots} slot(s))`
				: `fleet cannot admit ${capacity.requiredMb} MiB (available ${capacity.availableMb ?? "unknown"} MiB, reserve ${capacity.reserveMb}, volatility ${capacity.volatilityMb})`;
	const loads = [
		describeLoad("the fleet", input.fleet),
		capacityNote,
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
		return { tier: "fleet", runner: fleetLabel, reason: loads };
	return {
		tier: selected.backend === "local" ? "local" : "github",
		runner: selected.runsOn,
		reason: `${loads}; the limits are ${limits.maxWaitSeconds} s and ${limits.maxQueued} waiting`,
	};
}

type JsonValue =
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
 * Decides, and where a probe might still change the answer, waits for it.
 *
 * A wait is worth it only for a backend that is preferred to the one chosen,
 * that no runner has been seen on, and that nothing says is refusing jobs,
 * while a probe is under way and no run ahead has yet to choose. Every other
 * case is decided at once.
 */
async function readFleetCapacity(
	read: QueueReader,
	repository: string,
	fleetLabel: string,
): Promise<FleetLabelCapacity | undefined> {
	try {
		const page = await read(
			`/repos/${repository}/actions/variables/${FLEET_CAPACITY_VARIABLE}`,
		);
		const raw = asObject(page)?.value;
		let value: string | undefined;
		if (tagOf.call(raw) === "[object String]") {
			// SAFETY: the tag check proves a string primitive.
			value = raw as string;
		} else {
			value = asText(raw) ?? undefined;
		}
		const snapshot = parseFleetCapacityVariable(value);
		if (!snapshot) return undefined;
		return fleetLabelCapacity(snapshot, fleetLabel);
	} catch {
		return undefined;
	}
}

export async function chooseRunner(input: {
	observe: (nowMs: number) => Promise<QueueView>;
	now: () => number;
	sleep: (seconds: number) => Promise<void>;
	mode: RouteMode;
	fleetLabel: string;
	localEnrolled: boolean;
	limits: RouteLimits;
	readCapacity?: () => Promise<FleetLabelCapacity | undefined>;
}): Promise<RouteDecision> {
	const { fleetLabel, localEnrolled, limits } = input;
	const startMs = input.now();
	for (;;) {
		const nowMs = input.now();
		const view = await input.observe(nowMs);
		const fleet = labelLoad(view.jobs, fleetLabel, nowMs);
		const local = labelLoad(view.jobs, LOCAL_HOST_RUNNER_LABEL, nowMs);
		const fleetCapacity = input.readCapacity
			? await input.readCapacity()
			: undefined;
		const routed = {
			mode: input.mode,
			fleetLabel,
			localEnrolled,
			limits,
			fleet,
			local,
			undecidedAhead: view.undecidedAhead,
		};
		const decision =
			fleetCapacity === undefined
				? routeRunner(routed)
				: routeRunner({ ...routed, fleetCapacity });
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

const TRUNK_EVENTS = new Set([
	"push",
	"workflow_dispatch",
	"merge_group",
	"workflow_run",
]);

/** The label this run asks the fleet for; mirrors what the workflows asked for before routing. */
export function fleetLabelFor(
	event: string,
	trunkRunner: string | undefined,
): string {
	return trunkRunner !== "false" && TRUNK_EVENTS.has(event)
		? "hobo-trunk"
		: "hobo";
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function main(
	env: NodeJS.ProcessEnv = process.env,
): Promise<RouteDecision> {
	const fleetLabel = fleetLabelFor(
		env.GITHUB_EVENT_NAME ?? "",
		env.HOBO_CI_TRUNK_RUNNER,
	);
	const mode = parseRouteMode(env.HOBO_CI_ROUTE);
	const localEnrolled = env.HOBO_CI_LOCAL_RUNNER === "true";
	const limits = {
		maxWaitSeconds: positiveInteger(
			env.HOBO_CI_ROUTE_MAX_WAIT_SECONDS,
			DEFAULT_MAX_WAIT_SECONDS,
		),
		maxQueued: positiveInteger(
			env.HOBO_CI_ROUTE_MAX_QUEUED,
			DEFAULT_MAX_QUEUED,
		),
	};
	let decision: RouteDecision;
	try {
		const read = githubReader(
			env.GITHUB_API_URL ?? "https://api.github.com",
			env.GITHUB_TOKEN ?? "",
		);
		const repository = env.GITHUB_REPOSITORY ?? "";
		decision = await chooseRunner({
			observe: (nowMs) =>
				mode === "auto"
					? observeQueue({
							read,
							repository,
							ownRunId: Number(env.GITHUB_RUN_ID),
							labels: localEnrolled
								? [fleetLabel, LOCAL_HOST_RUNNER_LABEL]
								: [fleetLabel],
							limits,
							nowMs,
						})
					: Promise.resolve({
							jobs: [],
							undecidedAhead: 0,
							probeUnderway: false,
						}),
			now: Date.now,
			sleep: (wait) => delay(wait * 1000),
			mode,
			fleetLabel,
			localEnrolled,
			limits,
			readCapacity: () => readFleetCapacity(read, repository, fleetLabel),
		});
	} catch (error) {
		// This job is running on a GitHub-hosted machine, so that tier is known
		// to be up; with the queue unreadable, nothing is known about the others.
		decision = {
			tier: "github",
			runner: DEFAULT_GITHUB_MACHINE_TYPE,
			reason: `the queue could not be read (${error instanceof Error ? error.message : "unknown error"})`,
		};
	}
	const line = `runner: ${decision.runner} (${decision.tier}): ${decision.reason}`;
	console.log(line);
	if (env.GITHUB_OUTPUT)
		appendFileSync(
			env.GITHUB_OUTPUT,
			`runner=${decision.runner}\ntier=${decision.tier}\n`,
		);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
	return decision;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
