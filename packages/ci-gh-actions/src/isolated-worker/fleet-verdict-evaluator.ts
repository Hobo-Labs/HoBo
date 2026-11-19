import { leaseIdFromBoxRunnerName } from "../job-runner-custody.js";
import type { HostHealthVerdict } from "./host-health.js";
import {
	type HostPressureAdmissionThresholds,
	type HostResourcePressureSample,
	hostMemoryAdmitFits,
} from "./host-resource-pressure.js";

export const FLEET_VERDICT_POOL_FRESH_MS = 60_000;
export const FLEET_VERDICT_UNACCOUNTED_WINDOW_MS = 15 * 60_000;

export type FleetExternalPool = Readonly<{
	labels: readonly string[];
	runnerNamePrefix: string;
	maxRunners: number;
}>;

export type FleetJobOnRunner = Readonly<{
	label: string;
	runnerName: string;
	startedAtMs: number;
}>;

export type FleetPollView = Readonly<{
	completedAtMs: number;
	inProgress: readonly FleetJobOnRunner[];
}>;

export type FleetRunnersView = Readonly<{
	readAtMs: number;
	runners: readonly Readonly<{
		name: string;
		labels: readonly string[];
		online: boolean;
		busy: boolean;
	}>[];
}>;

export type FleetMeshPeer = Readonly<{
	labels: readonly string[];
	freeSlots: number;
}>;

export type FleetVerdictEvaluatorInput = Readonly<{
	nowMs: number;
	labels: readonly string[];
	idle: boolean;
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
	pools: readonly FleetExternalPool[];
	minFreeRunners: number;
	poll: FleetPollView | undefined;
	runners?: Readonly<{ view: FleetRunnersView | undefined }> | undefined;
	mesh: readonly FleetMeshPeer[] | undefined;
	ownLeaseIds: ReadonlySet<string>;
	pickups: readonly FleetJobOnRunner[];
}>;

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
	refused: boolean;
	labels: ReadonlyMap<string, FleetLabelEvaluation>;
	blocked: ReadonlyMap<string, "no-capacity">;
	unaccounted: readonly string[];
}>;

function refusals(
	input: FleetVerdictEvaluatorInput,
): readonly FleetLabelReason[] {
	const { host, admission } = input;
	const reasons: FleetLabelReason[] = [];
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

export function fleetRunnerNamePrefix(runnerName: string): string {
	const cut = runnerName.lastIndexOf("-");
	return cut < 0 ? runnerName : runnerName.slice(0, cut + 1);
}

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
		return input.ownLeaseIds.has(leaseId) || input.mesh !== undefined;
	return input.pools.some(
		(pool) =>
			pool.labels.includes(pickup.label) &&
			pickup.runnerName.startsWith(pool.runnerNamePrefix),
	);
}

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
