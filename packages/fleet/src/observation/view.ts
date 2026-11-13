/**
 * The fleet view and the fleet verdict (design §6.8 "Fleet view and
 * verdict"), moved from `packages/ci/src/mesh/report.ts`.
 *
 * A view lists a fleet's members, each with its state, availability since
 * when, health, capacity, tier and measured reliability. A member whose last
 * observation expired, or that was never observed, stays listed as `LOST`
 * while it is a member, so "it is gone" is something the view says. Every
 * surface that shows a fleet is built from this one function.
 *
 * The verdict is the one answer runner routing needs for a label: `OPEN`,
 * `NO_MEMBER` or `NO_CAPACITY`.
 */
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
	type ReliabilitySamples,
	VerdictState,
} from "../_generated/fleet_pb.js";
import type { MemberId } from "../ids.js";
import { fleetCapacity } from "./monitor.js";
import { scoreOfSamples } from "./reliability.js";

/** At most this many members are listed (§7.1 `FleetView.members`). */
export const VIEW_MEMBER_LIMIT = 256;
/** A view says nothing past this long after `as_of` (§7.1). */
export const VIEW_TTL_MS = 120_000;
/** A verdict says nothing past this long after `as_of` (§7.1). */
export const VERDICT_TTL_MS = 300_000;

const iso = (ms: number): string => new Date(ms).toISOString();

function msOf(text: string): number {
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Each member's newest observation that names this fleet. */
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
		// Lost: since its last observation expired.
		since: current ? observation.since : (observation?.validUntil ?? ""),
		lastSeen: observation?.issuedAt ?? "",
		agentVersion: observation?.agentVersion || member.agentVersion,
		labels: observation?.labels ?? [],
		deviceClass: member.deviceClass,
		roles: membership?.roles ?? [],
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
	// Active members first, so a truncated list still shows the ones that work.
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

/**
 * Live, active members serving `label` (any label when empty) and their free
 * slots. When a truncated list shows nobody for the label, the fleet's
 * capacity, which covers every member, answers instead: a partial list is not
 * evidence that nobody serves the label, and a wrong `NO_MEMBER` would send
 * runs away.
 */
export function buildFleetVerdict(
	view: FleetView,
	label: string,
	nowMs: number,
): FleetVerdict {
	const serving = view.members.filter(
		(member) =>
			member.state === MemberState.ACTIVE &&
			member.availability === Availability.LIVE &&
			(label === "" || member.labels.includes(label)),
	);
	let members = serving.length;
	let freeSlots = serving.reduce(
		(sum, member) => sum + (member.capacity?.freeSlots ?? 0),
		0,
	);
	if (view.truncated && members === 0 && view.capacity !== undefined) {
		members = view.capacity.healthy;
		freeSlots = view.capacity.freeSlots;
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
				: freeSlots === 0
					? VerdictState.NO_CAPACITY
					: VerdictState.OPEN,
		members,
		freeSlots,
		asOf: iso(nowMs),
		expiresAt: iso(expiresAtMs),
	});
}
