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
 * longer than the limit. Nothing is asked of the fleet itself, so a fleet that
 * is down, saturated, or cut off from its relay reads the same way.
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
export const DEFAULT_MAX_WAIT_SECONDS = 300;
/** A job queued this long was abandoned, not kept waiting; it says nothing about now. */
export const STALE_WAIT_SECONDS = 24 * 60 * 60;
/** Job lists read per decision; the oldest unfinished runs are read first. */
export const MAX_RUN_LOOKUPS = 12;

export type QueuedJob = Readonly<{
	runId: number;
	labels: readonly string[];
	createdAtMs: number;
}>;

export type LabelWait = Readonly<{ queued: number; oldestWaitSeconds: number }>;

export type RouteDecision = Readonly<{
	tier: RouteTier;
	runner: string;
	reason: string;
}>;

/** How long jobs asking for exactly `label` have waited, ignoring abandoned ones. */
export function labelWait(
	jobs: readonly QueuedJob[],
	label: string,
	nowMs: number,
): LabelWait {
	const waits = jobs
		.filter(
			(job) =>
				job.labels.length === 1 && job.labels[0]?.toLowerCase() === label,
		)
		.map((job) => Math.max(0, Math.floor((nowMs - job.createdAtMs) / 1000)))
		.filter((seconds) => seconds < STALE_WAIT_SECONDS);
	return {
		queued: waits.length,
		oldestWaitSeconds: waits.reduce(
			(oldest, wait) => Math.max(oldest, wait),
			0,
		),
	};
}

export function parseRouteMode(value: string | undefined): RouteMode {
	const mode = ROUTE_MODES.find((candidate) => candidate === value?.trim());
	return mode ?? "auto";
}

function describeWait(name: string, wait: LabelWait): string {
	return wait.queued === 0
		? `${name} has nothing waiting`
		: `${name} has ${wait.queued} waiting, the oldest for ${wait.oldestWaitSeconds} s`;
}

/**
 * The decision, from what the queue shows. `fleetLabel` is the label this run
 * would ask the fleet for (`hobo`, or `hobo-trunk` for trunk events).
 */
export function routeRunner(input: {
	mode: RouteMode;
	fleetLabel: string;
	localEnrolled: boolean;
	maxWaitSeconds: number;
	fleet: LabelWait;
	local: LabelWait;
}): RouteDecision {
	const { mode, fleetLabel, maxWaitSeconds } = input;
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
	const taking = (wait: LabelWait) =>
		wait.oldestWaitSeconds < maxWaitSeconds ? 1 : 0;
	const members = [
		{
			id: "fleet",
			backend: "hobo",
			enabled: true,
			runsOn: fleetLabel,
			freeSlots: taking(input.fleet),
		},
		{
			id: "local",
			backend: "local",
			enabled: input.localEnrolled,
			runsOn: LOCAL_HOST_RUNNER_LABEL,
			freeSlots: taking(input.local),
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
	const waits = [
		describeWait("the fleet", input.fleet),
		input.localEnrolled
			? describeWait("the local box", input.local)
			: "no local box is enrolled",
	].join("; ");
	if (!selected || selected.backend === "hobo")
		return { tier: "fleet", runner: fleetLabel, reason: waits };
	return {
		tier: selected.backend === "local" ? "local" : "github",
		runner: selected.runsOn,
		reason: `${waits}; the limit is ${maxWaitSeconds} s`,
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

/** The queued jobs on one page of a run's job list. */
export function queuedJobs(jobsPage: JsonValue): QueuedJob[] {
	return asList(asObject(jobsPage)?.jobs).flatMap((entry) => {
		const job = asObject(entry);
		const createdAt = Date.parse(asText(job?.created_at) ?? "");
		const runId = asNumber(job?.run_id);
		if (!job || asText(job.status) !== "queued") return [];
		if (runId === undefined || Number.isNaN(createdAt)) return [];
		return [
			{
				runId,
				labels: asList(job.labels).flatMap((label) => asText(label) ?? []),
				createdAtMs: createdAt,
			},
		];
	});
}

export type QueueReader = (path: string) => Promise<JsonValue>;

/**
 * Reads the queue until a label is seen waiting past the limit, or the oldest
 * runs are exhausted. The unfiltered run list is used because the
 * status-filtered one has gone on reporting no runs while runs were queued.
 */
export async function observeQueue(input: {
	read: QueueReader;
	repository: string;
	ownRunId: number;
	labels: readonly string[];
	maxWaitSeconds: number;
	nowMs: number;
}): Promise<QueuedJob[]> {
	const runs = unfinishedRunIds(
		await input.read(`/repos/${input.repository}/actions/runs?per_page=100`),
		input.ownRunId,
	);
	const seen: QueuedJob[] = [];
	for (const runId of runs.slice(0, MAX_RUN_LOOKUPS)) {
		seen.push(
			...queuedJobs(
				await input.read(
					`/repos/${input.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
				),
			),
		);
		const everyLabelPastLimit = input.labels.every(
			(label) =>
				labelWait(seen, label, input.nowMs).oldestWaitSeconds >=
				input.maxWaitSeconds,
		);
		if (everyLabelPastLimit) break;
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

export async function main(
	env: NodeJS.ProcessEnv = process.env,
): Promise<RouteDecision> {
	const fleetLabel = fleetLabelFor(
		env.GITHUB_EVENT_NAME ?? "",
		env.HOBO_CI_TRUNK_RUNNER,
	);
	const mode = parseRouteMode(env.HOBO_CI_ROUTE);
	const localEnrolled = env.HOBO_CI_LOCAL_RUNNER === "true";
	const requested = Number(env.HOBO_CI_ROUTE_MAX_WAIT_SECONDS);
	const maxWaitSeconds =
		Number.isInteger(requested) && requested > 0
			? requested
			: DEFAULT_MAX_WAIT_SECONDS;
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
						maxWaitSeconds,
						nowMs,
					})
				: [];
		decision = routeRunner({
			mode,
			fleetLabel,
			localEnrolled,
			maxWaitSeconds,
			fleet: labelWait(jobs, fleetLabel, nowMs),
			local: labelWait(jobs, LOCAL_HOST_RUNNER_LABEL, nowMs),
		});
	} catch (error) {
		// A queue that cannot be read is no evidence against the fleet.
		decision = {
			tier: "fleet",
			runner: fleetLabel,
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
