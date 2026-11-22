import { create } from "@bufbuild/protobuf";
import {
	Availability,
	type FleetMemberView,
	FleetMemberViewSchema,
	type FleetRecord,
	type FleetVerdict,
	FleetVerdictSchema,
	type FleetView,
	FleetViewSchema,
	Health,
	type MemberRecord,
	MemberState,
	type Observation,
	Refusal,
	type ReliabilitySamples,
	VerdictState,
} from "../_generated/fleet_pb.js";
import type { MemberId } from "../ids.js";
import { fleetCapacity } from "./monitor.js";
import { scoreOfSamples } from "./reliability.js";

export const VIEW_MEMBER_LIMIT = 256;
export const VIEW_TTL_MS = 120_000;
export const VERDICT_TTL_MS = 300_000;

const iso = (ms: number): string => new Date(ms).toISOString();

function msOf(text: string): number {
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function newestByMember(
	fleet: string,
	observations: readonly Observation[],
): ReadonlyMap<string, Observation> {
	const newest = new Map<string, Observation>();
	for (const observation of observations) {
		if (!observation.fleets.includes(fleet)) continue;
		const before = newest.get(observation.memberId);
		if (
			before === undefined ||
			msOf(observation.issuedAt) > msOf(before.issuedAt)
		)
			newest.set(observation.memberId, observation);
	}
	return newest;
}

function memberView(
	fleet: string,
	member: MemberRecord,
	observation: Observation | undefined,
	samples: ReliabilitySamples | undefined,
	nowMs: number,
): FleetMemberView {
	const membership = member.memberships.find((entry) => entry.fleet === fleet);
	const current =
		observation !== undefined && msOf(observation.validUntil) > nowMs;
	const availability = !current
		? Availability.LOST
		: observation.health === Health.REACHABLE
			? Availability.LIVE
			: Availability.UNHEALTHY;
	return create(FleetMemberViewSchema, {
		memberId: member.memberId,
		name: membership?.name ?? "",
		displayName: member.displayName,
		kind: member.kind,
		state: member.state,
		availability,
		health: current ? observation.health : Health.UNKNOWN,
		capacity: observation?.capacity,
		platform: observation?.platform ?? member.platform,
		attestationTier: member.attestationTier,
		sandboxTiers: observation?.sandboxTiers ?? [],
		reliability: samples === undefined ? undefined : scoreOfSamples(samples),
		samples,
		since: current ? observation.since : (observation?.validUntil ?? ""),
		lastSeen: observation?.issuedAt ?? "",
		agentVersion: observation?.agentVersion || member.agentVersion,
		labels: observation?.labels ?? [],
		deviceClass: member.deviceClass,
		roles: membership?.roles ?? [],
		refusal: current ? observation.refusal : Refusal.UNSPECIFIED,
	});
}

export function buildFleetView(
	fleet: FleetRecord,
	members: readonly MemberRecord[],
	observations: readonly Observation[],
	reliability: ReadonlyMap<MemberId, ReliabilitySamples>,
	nowMs: number,
): FleetView {
	const fleetId = fleet.fleetId;
	const inFleet = members.filter((member) =>
		member.memberships.some((entry) => entry.fleet === fleetId),
	);
	const newest = newestByMember(fleetId, observations);
	const samples = new Map<string, ReliabilitySamples>(reliability);
	const views = inFleet.map((member) =>
		memberView(
			fleetId,
			member,
			newest.get(member.memberId),
			samples.get(member.memberId),
			nowMs,
		),
	);
	const live = inFleet.flatMap((member) => {
		const observation = newest.get(member.memberId);
		return member.state === MemberState.ACTIVE &&
			observation !== undefined &&
			msOf(observation.validUntil) > nowMs
			? [observation]
			: [];
	});
	const listed = views
		.sort(
			(a, b) =>
				Number(b.state === MemberState.ACTIVE) -
					Number(a.state === MemberState.ACTIVE) ||
				a.name.localeCompare(b.name) ||
				a.memberId.localeCompare(b.memberId),
		)
		.slice(0, VIEW_MEMBER_LIMIT);
	return create(FleetViewSchema, {
		fleet: fleetId,
		members: listed,
		capacity: fleetCapacity(live),
		truncated: views.length > VIEW_MEMBER_LIMIT,
		asOf: iso(nowMs),
		notAfter: iso(nowMs + VIEW_TTL_MS),
	});
}

const REFUSING: ReadonlySet<Refusal> = new Set([
	Refusal.PRESSURE,
	Refusal.STORAGE,
	Refusal.DRAINING,
]);

export function buildFleetVerdict(
	view: FleetView,
	label: string,
	nowMs: number,
): FleetVerdict {
	const serving = view.members.filter(
		(member) =>
			member.state === MemberState.ACTIVE &&
			(member.availability === Availability.LIVE ||
				(member.availability === Availability.UNHEALTHY &&
					REFUSING.has(member.refusal))) &&
			(label === "" || member.labels.includes(label)),
	);
	let members = serving.length;
	let freeSlots = serving.reduce(
		(sum, member) =>
			sum +
			(REFUSING.has(member.refusal) ? 0 : (member.capacity?.freeSlots ?? 0)),
		0,
	);
	let refused =
		serving.length > 0 &&
		serving.every((member) => REFUSING.has(member.refusal));
	if (view.truncated && members === 0 && view.capacity !== undefined) {
		members = view.capacity.healthy;
		freeSlots = view.capacity.freeSlots;
		refused = false;
	}
	const expiresAtMs = Math.max(
		nowMs,
		Math.min(nowMs + VERDICT_TTL_MS, msOf(view.notAfter)),
	);
	return create(FleetVerdictSchema, {
		fleet: view.fleet,
		label,
		state:
			members === 0
				? VerdictState.NO_MEMBER
				: freeSlots > 0
					? VerdictState.OPEN
					: refused
						? VerdictState.NO_CAPACITY
						: VerdictState.BUSY,
		members,
		freeSlots,
		asOf: iso(nowMs),
		expiresAt: iso(expiresAtMs),
	});
}
