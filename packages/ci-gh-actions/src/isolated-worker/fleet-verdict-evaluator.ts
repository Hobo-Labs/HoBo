/**
 * When the box relay says a fleet label is blocked (ADR-0180 amendment,
 * item 1). Pure: plain values in, a verdict per label out. It never calls
 * `admit`, `availableLowWaterMb` or anything else on the memory admission
 * object, and reads only the host sample it is given.
 *
 * A label is blocked only while both hold:
 *
 * 1. Admission would refuse a job for a reason other than the box's own
 *    running jobs. Idle, that is memory headroom, memory or CPU pressure
 *    stall, or swap (`hostMemoryAdmitFits` with nothing committed). Idle or
 *    busy, it is a host health verdict that is `critical` for a disk or
 *    inode reason (ADR-0181, decision 5: critical host or storage health refuses
 *    whether or not the box is busy). A busy box short of memory is short
 *    because of its own jobs, and is never refused (R4). The load-average
 *    check admission also makes is left out on purpose: the one-minute load
 *    stays high for minutes after CI's own jobs end.
 * 2. Nothing else can take the job: no live healthy mesh peer serving the
 *    label has a free slot; the declared pools serving it have fewer free
 *    runners than the minimum, by a count no older than 60 s; and no runner
 *    the relay cannot account for took a job on it in the last 15 minutes.
 *
 * Pools are counted one of two ways. With `runners`, from GitHub's runner
 * list (`GET /actions/runners`: online, `busy: false`, the pool's label and
 * name prefix), which the routing slip issuer uses (ADR-0181, decision 5).
 * Without it, from the last poll's jobs in progress against `maxRunners`.
 *
 * Anything unknown (a stale count, no count) leaves the label open (R3).
 */
import { leaseIdFromBoxRunnerName } from "../job-runner-custody.js";
import type { HostHealthVerdict } from "./host-health.js";
import {
	type HostPressureAdmissionThresholds,
	type HostResourcePressureSample,
	hostMemoryAdmitFits,
} from "./host-resource-pressure.js";

/** A pool count from a poll older than this is unknown. */
export const FLEET_VERDICT_POOL_FRESH_MS = 60_000;
/** How far back a job taken by a runner nobody can count keeps a label open. */
export const FLEET_VERDICT_UNACCOUNTED_WINDOW_MS = 15 * 60_000;

/** A runner pool outside this box that serves fleet labels (ARC, say). */
export type FleetExternalPool = Readonly<{
	labels: readonly string[];
	/** Every runner of the pool is named with this prefix. */
	runnerNamePrefix: string;
	/** How many jobs the pool runs at once. */
	maxRunners: number;
}>;

/** A job a runner has taken on a fleet label, as GitHub reported it. */
export type FleetJobOnRunner = Readonly<{
	label: string;
	runnerName: string;
	startedAtMs: number;
}>;

/** What the last completed poll saw in progress, and when it completed. */
export type FleetPollView = Readonly<{
	completedAtMs: number;
	inProgress: readonly FleetJobOnRunner[];
}>;

/** GitHub's runner list for a repository, and when it was read. */
export type FleetRunnersView = Readonly<{
	readAtMs: number;
	runners: readonly Readonly<{
		name: string;
		labels: readonly string[];
		online: boolean;
		busy: boolean;
	}>[];
}>;

/** A live, healthy mesh peer (never this box). */
export type FleetMeshPeer = Readonly<{
	labels: readonly string[];
	freeSlots: number;
}>;

export type FleetVerdictEvaluatorInput = Readonly<{
	nowMs: number;
	/** The fleet labels this box serves. */
	labels: readonly string[];
	/** No active lease, no launch slot in use, none of the box's own background work. */
	idle: boolean;
	host: Readonly<{
		/** Free memory now, as admission reads it; absent when unreadable. */
		availableMb: number | undefined;
		pressure: HostResourcePressureSample;
		/** The host health monitor's held verdict; absent when it has none. */
		health: HostHealthVerdict | undefined;
	}>;
	admission: Readonly<{
		standardClassMb: number;
		reserveMb: number;
		volatilityMb: number;
		thresholds?: HostPressureAdmissionThresholds | undefined;
	}>;
	pools: readonly FleetExternalPool[];
	/** Free runners the rest of the fleet must have for a label to stay open. */
	minFreeRunners: number;
	/** The last completed poll; absent when there has been none. */
	poll: FleetPollView | undefined;
	/**
	 * GitHub's runner list, when pools are counted by it; absent when they
	 * are counted from `poll`. An undefined `view` means it could not be read.
	 */
	runners?: Readonly<{ view: FleetRunnersView | undefined }> | undefined;
	/** Live healthy peers; absent when there is no mesh. */
	mesh: readonly FleetMeshPeer[] | undefined;
	/** Lease ids this box holds or held, among the runners in `pickups`. */
	ownLeaseIds: ReadonlySet<string>;
	/** Jobs taken on fleet labels lately, from successive polls. */
	pickups: readonly FleetJobOnRunner[];
}>;

/** Why a label is blocked, or what kept it open. */
export type FleetLabelReason =
	| "memory"
	| "storage-bytes"
	| "storage-inodes"
	| "not-idle"
	| "admits"
	| "mesh-peer-free"
	| "poll-stale"
	| "pool-free"
	| "unaccounted-runner";

export type FleetLabelEvaluation = Readonly<{
	blocked: boolean;
	reasons: readonly FleetLabelReason[];
}>;

export type FleetVerdictEvaluation = Readonly<{
	/** Whether admission would refuse a job on this host sample. */
	refused: boolean;
	labels: ReadonlyMap<string, FleetLabelEvaluation>;
	/** The labels to report blocked; the reason is always `no-capacity`. */
	blocked: ReadonlyMap<string, "no-capacity">;
	/** Runners that took a job lately and that nobody can count. */
	unaccounted: readonly string[];
}>;

/** What admission would refuse on, from the sample alone. */
function refusals(
	input: FleetVerdictEvaluatorInput,
): readonly FleetLabelReason[] {
	const { host, admission } = input;
	const reasons: FleetLabelReason[] = [];
	// The same conjunction admission uses, with nothing committed.
	if (
		!hostMemoryAdmitFits(
			host.availableMb,
			admission.standardClassMb,
			admission.reserveMb,
			admission.volatilityMb,
			host.pressure,
			admission.thresholds,
			0,
		)
	)
		reasons.push("memory");
	if (host.health?.state === "critical")
		for (const reason of host.health.reasons)
			if (reason === "storage-bytes" || reason === "storage-inodes")
				reasons.push(reason);
	return reasons;
}

/** The part of a runner name its siblings share: up to its last `-`. */
export function fleetRunnerNamePrefix(runnerName: string): string {
	const cut = runnerName.lastIndexOf("-");
	return cut < 0 ? runnerName : runnerName.slice(0, cut + 1);
}

/**
 * The lease ids named by box runners (`hobo-<lease uuid>`) among these jobs:
 * the ids a caller looks up in its own journal to fill `ownLeaseIds`.
 */
export function boxLeaseIdsOf(jobs: readonly FleetJobOnRunner[]): string[] {
	const ids = new Set<string>();
	for (const job of jobs) {
		const id = leaseIdFromBoxRunnerName(job.runnerName);
		if (id !== undefined) ids.add(id);
	}
	return [...ids];
}

function accounted(
	input: FleetVerdictEvaluatorInput,
	pickup: FleetJobOnRunner,
): boolean {
	const leaseId = leaseIdFromBoxRunnerName(pickup.runnerName);
	if (leaseId !== undefined)
		// This box's runner, or (only with a mesh) a peer box's.
		return input.ownLeaseIds.has(leaseId) || input.mesh !== undefined;
	return input.pools.some(
		(pool) =>
			pool.labels.includes(pickup.label) &&
			pickup.runnerName.startsWith(pool.runnerNamePrefix),
	);
}

/** Free runners of the declared pools serving `label`, or undefined when unknown. */
function freeRunners(
	input: FleetVerdictEvaluatorInput,
	poll: FleetPollView | undefined,
	label: string,
): number | undefined {
	if (input.runners) {
		const view = input.runners.view;
		if (!view || input.nowMs - view.readAtMs > FLEET_VERDICT_POOL_FRESH_MS)
			return undefined;
		let free = 0;
		for (const pool of input.pools) {
			if (!pool.labels.includes(label)) continue;
			const idle = view.runners.filter(
				(runner) =>
					runner.online &&
					!runner.busy &&
					runner.labels.includes(label) &&
					runner.name.startsWith(pool.runnerNamePrefix),
			).length;
			free += Math.min(idle, pool.maxRunners);
		}
		return free;
	}
	if (!poll) return undefined;
	let free = 0;
	for (const pool of input.pools) {
		if (!pool.labels.includes(label)) continue;
		const busy = poll.inProgress.filter(
			(job) =>
				pool.labels.includes(job.label) &&
				job.runnerName.startsWith(pool.runnerNamePrefix),
		).length;
		free += Math.max(0, pool.maxRunners - busy);
	}
	return free;
}

export function evaluateFleetVerdict(
	input: FleetVerdictEvaluatorInput,
): FleetVerdictEvaluation {
	const refusedFor = refusals(input);
	const refused = refusedFor.length > 0;
	// Busy, only a health refusal counts: memory is the box's own jobs' (R4).
	const healthRefusals = refusedFor.filter((reason) => reason !== "memory");
	const unaccountedPickups = input.pickups.filter(
		(pickup) =>
			input.nowMs - pickup.startedAtMs <= FLEET_VERDICT_UNACCOUNTED_WINDOW_MS &&
			input.labels.includes(pickup.label) &&
			!accounted(input, pickup),
	);
	const poll =
		input.poll !== undefined &&
		input.nowMs - input.poll.completedAtMs <= FLEET_VERDICT_POOL_FRESH_MS
			? input.poll
			: undefined;
	const labels = new Map<string, FleetLabelEvaluation>();
	const blocked = new Map<string, "no-capacity">();
	for (const label of input.labels) {
		const open: FleetLabelReason[] = [];
		if (!input.idle && healthRefusals.length === 0) open.push("not-idle");
		else if (!refused) open.push("admits");
		else {
			if (
				input.mesh?.some(
					(peer) => peer.freeSlots > 0 && peer.labels.includes(label),
				)
			)
				open.push("mesh-peer-free");
			const free = freeRunners(input, poll, label);
			if (free === undefined) open.push("poll-stale");
			else if (free >= input.minFreeRunners) open.push("pool-free");
			if (unaccountedPickups.some((pickup) => pickup.label === label))
				open.push("unaccounted-runner");
		}
		if (open.length === 0) {
			labels.set(label, {
				blocked: true,
				reasons: input.idle ? refusedFor : healthRefusals,
			});
			blocked.set(label, "no-capacity");
		} else labels.set(label, { blocked: false, reasons: open });
	}
	return {
		refused,
		labels,
		blocked,
		unaccounted: [
			...new Set(unaccountedPickups.map((pickup) => pickup.runnerName)),
		],
	};
}
