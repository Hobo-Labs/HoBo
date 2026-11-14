/**
 * What the routing slip says of each label this box serves (ADR-0181,
 * decision 5; design §8.2): an adapter over `fleetVerdict` of
 * `@hobo/fleet/observation`. Pure: plain values and a fleet view in, an
 * evaluation per label out. It never calls `admit` or anything else on the
 * memory admission object, and reads only the host sample it is given.
 *
 * The box puts itself into the fleet's view as it is this instant (free
 * launch slots, labels, and why it admits nothing new, as an `Observation`
 * refusal would say it), beside its peers from `FleetView.members` (the
 * authority's signed view, in fleet mode), and asks `fleetVerdict` per label.
 * `BUSY` (no free slot only because of members' own work) is `fleet-busy` and
 * never a refusal (ADR-0181 R4, D60).
 *
 * A label is refused (`no-capacity`) only while all of these hold:
 *
 * 1. Admission would refuse a job here for a reason other than the box's own
 *    running jobs. Idle, that is memory headroom, memory or CPU pressure
 *    stall, or swap (`hostMemoryAdmitFits` with nothing committed). Idle or
 *    busy, it is a host health verdict that is `critical` for a disk or
 *    inode reason. A busy box short of memory is short because of its own
 *    jobs, and is never refused (R4). The load average is left out on
 *    purpose: it stays high for minutes after CI's own jobs end.
 * 2. `fleetVerdict` over the box and its peers is `NO_CAPACITY`: no live
 *    peer serving the label has a free slot or is merely busy.
 * 3. The declared pools serving it have fewer free runners than the minimum,
 *    by a count no older than 60 s, and no runner nobody can account for took
 *    a job on it in the last 15 minutes. That counting is routing, not fleet
 *    state, and stays here.
 *
 * Pools are counted one of two ways. With `runners`, from GitHub's runner
 * list (online, `busy: false`, the pool's label and name prefix). Without
 * it, from the last poll's jobs in progress against `maxRunners`.
 *
 * Anything unknown (a stale count, no count, a lapsed view) leaves the label
 * open (R3).
 */
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	Availability,
	type FleetMemberView,
	FleetMemberViewSchema,
	type FleetView,
	FleetViewSchema,
	type MemberId,
	MemberState,
	parseWorkDigest,
	Refusal,
	Role,
	VerdictState,
} from "@hobo/fleet";
import { fleetVerdict, leaderOf, rankMembers } from "@hobo/fleet/observation";
import { leaseIdFromBoxRunnerName } from "../job-runner-custody.js";
import type { HostHealthVerdict } from "./host-health.js";
import {
	type HostPressureAdmissionThresholds,
	type HostResourcePressureSample,
	hostMemoryAdmitFits,
} from "./host-resource-pressure.js";

/** A pool count from a poll older than this is unknown. */
export const ROUTING_POOL_FRESH_MS = 60_000;
/** How far back a job taken by a runner nobody can count keeps a label open. */
export const ROUTING_UNACCOUNTED_WINDOW_MS = 15 * 60_000;

/** A runner pool outside this box that serves routed labels (ARC, say). */
export type RunnerExternalPool = Readonly<{
	labels: readonly string[];
	/** Every runner of the pool is named with this prefix. */
	runnerNamePrefix: string;
	/** How many jobs the pool runs at once. */
	maxRunners: number;
}>;

/** A job a runner has taken on a routed label, as GitHub reported it. */
export type RunnerJobOnLabel = Readonly<{
	label: string;
	runnerName: string;
	startedAtMs: number;
}>;

/** What the last completed poll saw in progress, and when it completed. */
export type RunnerPollView = Readonly<{
	completedAtMs: number;
	inProgress: readonly RunnerJobOnLabel[];
}>;

/** GitHub's runner list for a repository, and when it was read. */
export type RepositoryRunnersView = Readonly<{
	readAtMs: number;
	runners: readonly Readonly<{
		name: string;
		labels: readonly string[];
		online: boolean;
		busy: boolean;
	}>[];
}>;

export type RoutingSlipEvaluatorInput = Readonly<{
	nowMs: number;
	/** The routed labels this box serves. */
	labels: readonly string[];
	/** No active lease, no launch slot in use, none of the box's own background work. */
	idle: boolean;
	/** Launch slots free on this box now. */
	freeSlots: number;
	/** A draining box serves nothing: it is left out of the view. */
	draining?: boolean | undefined;
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
	pools: readonly RunnerExternalPool[];
	/** Free runners elsewhere a label needs to stay open. */
	minFreeRunners: number;
	/** The last completed poll; absent when there has been none. */
	poll: RunnerPollView | undefined;
	/**
	 * GitHub's runner list, when pools are counted by it; absent when they
	 * are counted from `poll`. An undefined `view` means it could not be read.
	 */
	runners?: Readonly<{ view: RepositoryRunnersView | undefined }> | undefined;
	/**
	 * The fleet as the authority last signed it (`FleetView`), and this box's
	 * member id in it; absent on a box that is not a fleet member. A view past
	 * its `not_after` is not used.
	 */
	fleet?: Readonly<{ view: FleetView; self: MemberId }> | undefined;
	/** Lease ids this box holds or held, among the runners in `pickups`. */
	ownLeaseIds: ReadonlySet<string>;
	/** Jobs taken on routed labels lately, from successive polls. */
	pickups: readonly RunnerJobOnLabel[];
}>;

/** Why a label is refused, or what kept it open. */
export type RoutingLabelReason =
	| "memory"
	| "storage-bytes"
	| "storage-inodes"
	| "not-idle"
	| "admits"
	| "peer-free"
	| "peer-busy"
	| "poll-stale"
	| "pool-free"
	| "unaccounted-runner";

export type RoutingLabelEvaluation = Readonly<{
	blocked: boolean;
	reasons: readonly RoutingLabelReason[];
	/** `fleetVerdict` over this box and its peers, for this label. */
	verdict: VerdictState;
}>;

export type RoutingSlipEvaluation = Readonly<{
	/** Whether admission would refuse a job on this host sample. */
	refused: boolean;
	/** The refusal this box's own observation would carry now (D60). */
	refusal: Refusal;
	labels: ReadonlyMap<string, RoutingLabelEvaluation>;
	/** The labels to refuse; the reason is always `no-capacity`. */
	blocked: ReadonlyMap<string, "no-capacity">;
	/** Labels a live member (this box or a peer) serves; the rest are `no-node`. */
	served: ReadonlySet<string>;
	/** Labels with no free slot anywhere: `fleet-busy` unless refused. */
	full: ReadonlySet<string>;
	/** Runners that took a job lately and that nobody can count. */
	unaccounted: readonly string[];
}>;

/** What admission would refuse on, from the sample alone. */
function refusals(
	input: RoutingSlipEvaluatorInput,
): readonly RoutingLabelReason[] {
	const { host, admission } = input;
	const reasons: RoutingLabelReason[] = [];
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
export function runnerNamePrefixOf(runnerName: string): string {
	const cut = runnerName.lastIndexOf("-");
	return cut < 0 ? runnerName : runnerName.slice(0, cut + 1);
}

/**
 * The lease ids named by box runners (`hobo-<lease uuid>`) among these jobs:
 * the ids a caller looks up in its own journal to fill `ownLeaseIds`.
 */
export function boxLeaseIdsOf(jobs: readonly RunnerJobOnLabel[]): string[] {
	const ids = new Set<string>();
	for (const job of jobs) {
		const id = leaseIdFromBoxRunnerName(job.runnerName);
		if (id !== undefined) ids.add(id);
	}
	return [...ids];
}

/** The fleet view, while the authority's `not_after` has not passed. */
function currentView(input: RoutingSlipEvaluatorInput) {
	const fleet = input.fleet;
	if (fleet === undefined) return undefined;
	const notAfterMs = Date.parse(fleet.view.notAfter);
	return Number.isFinite(notAfterMs) && notAfterMs > input.nowMs
		? fleet
		: undefined;
}

function accounted(
	input: RoutingSlipEvaluatorInput,
	peersKnown: boolean,
	pickup: RunnerJobOnLabel,
): boolean {
	const leaseId = leaseIdFromBoxRunnerName(pickup.runnerName);
	if (leaseId !== undefined)
		// This box's runner, or (only in a fleet) a peer box's.
		return input.ownLeaseIds.has(leaseId) || peersKnown;
	return input.pools.some(
		(pool) =>
			pool.labels.includes(pickup.label) &&
			pickup.runnerName.startsWith(pool.runnerNamePrefix),
	);
}

/** Free runners of the declared pools serving `label`, or undefined when unknown. */
function freeRunners(
	input: RoutingSlipEvaluatorInput,
	poll: RunnerPollView | undefined,
	label: string,
): number | undefined {
	if (input.runners) {
		const view = input.runners.view;
		if (!view || input.nowMs - view.readAtMs > ROUTING_POOL_FRESH_MS)
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

/** This box's refusal as its observation would say it (D60). */
function boxRefusal(
	input: RoutingSlipEvaluatorInput,
	refusedFor: readonly RoutingLabelReason[],
): Refusal {
	if (input.draining) return Refusal.DRAINING;
	if (refusedFor.some((reason) => reason !== "memory")) return Refusal.STORAGE;
	if (refusedFor.includes("memory"))
		return input.idle ? Refusal.PRESSURE : Refusal.OWN_WORK;
	return input.freeSlots > 0 ? Refusal.NONE : Refusal.OWN_WORK;
}

const SELF_ID = "self";

/** The box and its peers as one view, the box as it is this instant. */
function viewWithBox(
	input: RoutingSlipEvaluatorInput,
	refusal: Refusal,
): FleetView {
	const fleet = currentView(input);
	const selfId = fleet?.self ?? SELF_ID;
	const peers = (fleet?.view.members ?? []).filter(
		(member) => member.memberId !== selfId,
	);
	const refusing =
		refusal === Refusal.PRESSURE ||
		refusal === Refusal.STORAGE ||
		refusal === Refusal.DRAINING;
	const box: FleetMemberView[] = input.draining
		? []
		: [
				create(FleetMemberViewSchema, {
					memberId: selfId,
					state: MemberState.ACTIVE,
					availability: Availability.LIVE,
					capacity: { freeSlots: refusing ? 0 : Math.max(0, input.freeSlots) },
					labels: [...input.labels],
					roles: [Role.DISPATCHER, Role.EXECUTOR],
					refusal,
				}),
			];
	return create(FleetViewSchema, {
		fleet: fleet?.view.fleet ?? "",
		members: [...box, ...peers],
		// The box is always listed, so a truncated list never hides a label it serves.
		truncated: false,
		asOf: new Date(input.nowMs).toISOString(),
		notAfter: new Date(input.nowMs + ROUTING_POOL_FRESH_MS).toISOString(),
	});
}

export function evaluateRoutingSlip(
	input: RoutingSlipEvaluatorInput,
): RoutingSlipEvaluation {
	const refusedFor = refusals(input);
	const refused = refusedFor.length > 0;
	// Busy, only a health refusal counts: memory is the box's own jobs' (R4).
	const healthRefusals = refusedFor.filter((reason) => reason !== "memory");
	const refusal = boxRefusal(input, refusedFor);
	const peersKnown = currentView(input) !== undefined;
	const view = viewWithBox(input, refusal);
	const unaccountedPickups = input.pickups.filter(
		(pickup) =>
			input.nowMs - pickup.startedAtMs <= ROUTING_UNACCOUNTED_WINDOW_MS &&
			input.labels.includes(pickup.label) &&
			!accounted(input, peersKnown, pickup),
	);
	const poll =
		input.poll !== undefined &&
		input.nowMs - input.poll.completedAtMs <= ROUTING_POOL_FRESH_MS
			? input.poll
			: undefined;
	const labels = new Map<string, RoutingLabelEvaluation>();
	const blocked = new Map<string, "no-capacity">();
	const served = new Set<string>();
	const full = new Set<string>();
	for (const member of view.members)
		if (
			member.state === MemberState.ACTIVE &&
			member.availability === Availability.LIVE
		)
			for (const label of member.labels) served.add(label);
	for (const label of new Set([...input.labels, ...served])) {
		const verdict = fleetVerdict(view, label, input.nowMs).state;
		if (verdict !== VerdictState.OPEN && verdict !== VerdictState.NO_MEMBER)
			full.add(label);
		if (!input.labels.includes(label)) continue;
		const open: RoutingLabelReason[] = [];
		if (!input.idle && healthRefusals.length === 0) open.push("not-idle");
		else if (!refused) open.push("admits");
		else {
			if (verdict === VerdictState.OPEN) open.push("peer-free");
			else if (verdict === VerdictState.BUSY) open.push("peer-busy");
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
				verdict,
			});
			blocked.set(label, "no-capacity");
		} else labels.set(label, { blocked: false, reasons: open, verdict });
	}
	return {
		refused,
		refusal,
		labels,
		blocked,
		served,
		full,
		unaccounted: [
			...new Set(unaccountedPickups.map((pickup) => pickup.runnerName)),
		],
	};
}

const LEADER_DIGEST_CONTEXT = "hobo-ci/routing-slip-leader/v1";

/**
 * Whether this box writes the slip: rank 0 of `rankMembers` over the fleet's
 * live `DISPATCHER` members (`leaderOf`, replacing main's `meshLeaderId`).
 * With no current view, or none ranked, the box leads itself.
 */
export function routingSlipLeader(
	fleet: Readonly<{ view: FleetView; self: MemberId }> | undefined,
	nowMs: number,
): MemberId | undefined {
	if (fleet === undefined) return undefined;
	const notAfterMs = Date.parse(fleet.view.notAfter);
	if (!Number.isFinite(notAfterMs) || notAfterMs <= nowMs) return fleet.self;
	const digest = parseWorkDigest(
		createHash("sha256")
			.update(`${LEADER_DIGEST_CONTEXT}\n${fleet.view.fleet}`)
			.digest("hex")
			.slice(0, 32),
	);
	const candidates = fleet.view.members.flatMap((member) =>
		member.state === MemberState.ACTIVE &&
		member.availability === Availability.LIVE &&
		member.roles.includes(Role.DISPATCHER)
			? [
					{
						// SAFETY: member ids in a view the authority signed passed parseMemberId there.
						memberId: member.memberId as MemberId,
						copies: 1,
						reliability: member.reliability ?? 1,
					},
				]
			: [],
	);
	return leaderOf(rankMembers(digest, candidates), fleet.self);
}
