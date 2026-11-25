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
	parseMemberId,
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

export const ROUTING_POOL_FRESH_MS = 60_000;
export const ROUTING_UNACCOUNTED_WINDOW_MS = 15 * 60_000;

export type RunnerExternalPool = Readonly<{
	labels: readonly string[];
	runnerNamePrefix: string;
	maxRunners: number;
}>;

export type RunnerJobOnLabel = Readonly<{
	label: string;
	runnerName: string;
	startedAtMs: number;
}>;

export type RunnerPollView = Readonly<{
	completedAtMs: number;
	inProgress: readonly RunnerJobOnLabel[];
}>;

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
	labels: readonly string[];
	idle: boolean;
	freeSlots: number;
	draining?: boolean | undefined;
	host: Readonly<{
		availableMb: number | undefined;
		pressure: HostResourcePressureSample;
		health: HostHealthVerdict | undefined;
	}>;
	admission: Readonly<{
		standardClassMb: number;
		reserveMb: number;
		volatilityMb: number;
		thresholds?: HostPressureAdmissionThresholds | undefined;
	}>;
	pools: readonly RunnerExternalPool[];
	minFreeRunners: number;
	poll: RunnerPollView | undefined;
	runners?: Readonly<{ view: RepositoryRunnersView | undefined }> | undefined;
	fleet?: Readonly<{ view: FleetView; self: MemberId }> | undefined;
	ownLeaseIds: ReadonlySet<string>;
	pickups: readonly RunnerJobOnLabel[];
}>;

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
	verdict: VerdictState;
}>;

export type RoutingSlipEvaluation = Readonly<{
	refused: boolean;
	refusal: Refusal;
	labels: ReadonlyMap<string, RoutingLabelEvaluation>;
	blocked: ReadonlyMap<string, "no-capacity">;
	served: ReadonlySet<string>;
	full: ReadonlySet<string>;
	unaccounted: readonly string[];
}>;

function refusals(
	input: RoutingSlipEvaluatorInput,
): readonly RoutingLabelReason[] {
	const { host, admission } = input;
	const reasons: RoutingLabelReason[] = [];
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

export function runnerNamePrefixOf(runnerName: string): string {
	const cut = runnerName.lastIndexOf("-");
	return cut < 0 ? runnerName : runnerName.slice(0, cut + 1);
}

export function boxLeaseIdsOf(jobs: readonly RunnerJobOnLabel[]): string[] {
	const ids = new Set<string>();
	for (const job of jobs) {
		const id = leaseIdFromBoxRunnerName(job.runnerName);
		if (id !== undefined) ids.add(id);
	}
	return [...ids];
}

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
		return input.ownLeaseIds.has(leaseId) || peersKnown;
	return input.pools.some(
		(pool) =>
			pool.labels.includes(pickup.label) &&
			pickup.runnerName.startsWith(pool.runnerNamePrefix),
	);
}

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
						memberId: parseMemberId(member.memberId),
						copies: 1,
						reliability: member.reliability ?? 1,
					},
				]
			: [],
	);
	return leaderOf(rankMembers(digest, candidates), fleet.self);
}
