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
 * shares: a backend is taking jobs when no job asking for its label has waited
 * past the limit, it has not been slow to pick up what it took recently, and
 * few jobs are already waiting for it. Nothing is asked of the fleet itself,
 * so a fleet that is down, saturated, or cut off from its relay reads the same.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_GITHUB_MACHINE_TYPE,
	type FleetMember,
	LOCAL_HOST_RUNNER_LABEL,
	selectFleetBackend,
} from "../../packages/ci/src/fleet-overflow.ts";

/** `auto` falls back; the others pin one tier, `fleet` being the behaviour before routing. */
export const ROUTE_MODES = ["auto", "fleet", "local", "github"] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

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
	const pickups = asking.flatMap((job) =>
		job.startedAtMs !== undefined &&
		seconds(job.startedAtMs, nowMs) <= RECENT_PICKUP_SECONDS
			? [seconds(job.createdAtMs, job.startedAtMs)]
			: [],
	);
	const longest = (values: readonly number[]) =>
		values.reduce((most, value) => Math.max(most, value), 0);
	return {
		queued: waits.length,
		oldestWaitSeconds: longest(waits),
		slowestRecentPickupSeconds: longest(pickups),
	};
}

/**
 * A backend is taking jobs when nothing has waited for it past the limit, it
 * has not been slow to pick up what it took recently, and fewer jobs than the
 * limit are already waiting. The last is what a wait alone misses: a queue
 * that was just emptied and refilled is full long before its oldest job is old.
 */
export function takingJobs(load: LabelLoad, limits: RouteLimits): boolean {
	return (
		load.oldestWaitSeconds < limits.maxWaitSeconds &&
		load.slowestRecentPickupSeconds < limits.maxWaitSeconds &&
		load.queued < limits.maxQueued
	);
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
	return load.slowestRecentPickupSeconds === 0
		? waiting
		: `${waiting}, and recently took ${load.slowestRecentPickupSeconds} s to pick a job up`;
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
	const members = [
		{
			id: "fleet",
			backend: "hobo",
			enabled: true,
			runsOn: fleetLabel,
			freeSlots: takingJobs(input.fleet, limits) ? 1 : 0,
		},
		{
			id: "local",
			backend: "local",
			enabled: input.localEnrolled,
			runsOn: LOCAL_HOST_RUNNER_LABEL,
			freeSlots: takingJobs(input.local, limits) ? 1 : 0,
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
	const loads = [
		describeLoad("the fleet", input.fleet),
		input.localEnrolled
			? describeLoad("the local box", input.local)
			: "no local box is enrolled",
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

/** Runs GitHub has not finished, oldest first, from one page of the unfiltered list. */
export function unfinishedRunIds(
	runsPage: JsonValue,
	ownRunId: number,
): number[] {
	return asList(asObject(runsPage)?.workflow_runs)
		.map((run) => asObject(run))
		.filter((run) => run !== undefined && asText(run.status) !== "completed")
		.map((run) => asNumber(run?.id))
		.filter((id) => id !== undefined && id !== ownRunId)
		.map((id) => id ?? 0)
		.sort((left, right) => left - right);
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

/**
 * Reads the queue until every label is seen not taking jobs, or the runs to
 * read are exhausted. The unfiltered run list is used because the
 * status-filtered one has gone on reporting no runs while runs were queued.
 */
export async function observeQueue(input: {
	read: QueueReader;
	repository: string;
	ownRunId: number;
	labels: readonly string[];
	limits: RouteLimits;
	nowMs: number;
}): Promise<SeenJob[]> {
	const runs = lookupOrder(
		unfinishedRunIds(
			await input.read(`/repos/${input.repository}/actions/runs?per_page=100`),
			input.ownRunId,
		),
	);
	const seen: SeenJob[] = [];
	for (const runId of runs.slice(0, MAX_RUN_LOOKUPS)) {
		seen.push(
			...seenJobs(
				await input.read(
					`/repos/${input.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
				),
			),
		);
		const noneTaking = input.labels.every(
			(label) => !takingJobs(labelLoad(seen, label, input.nowMs), input.limits),
		);
		if (noneTaking) break;
	}
	return seen;
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
	const nowMs = Date.now();
	let decision: RouteDecision;
	try {
		const jobs =
			mode === "auto"
				? await observeQueue({
						read: githubReader(
							env.GITHUB_API_URL ?? "https://api.github.com",
							env.GITHUB_TOKEN ?? "",
						),
						repository: env.GITHUB_REPOSITORY ?? "",
						ownRunId: Number(env.GITHUB_RUN_ID),
						labels: localEnrolled
							? [fleetLabel, LOCAL_HOST_RUNNER_LABEL]
							: [fleetLabel],
						limits,
						nowMs,
					})
				: [];
		decision = routeRunner({
			mode,
			fleetLabel,
			localEnrolled,
			limits,
			fleet: labelLoad(jobs, fleetLabel, nowMs),
			local: labelLoad(jobs, LOCAL_HOST_RUNNER_LABEL, nowMs),
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
