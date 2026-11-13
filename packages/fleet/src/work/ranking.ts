/**
 * Who could take one offer, best first (design §6.9 step 2): every executor
 * of the fleet with an accepted, unexpired observation of itself that the
 * offer fits, at or above the fleet's `min_agent_version`, inside the
 * residency rules, and able to provide the tier §6.11 requires for the class
 * it would derive. Weights are its copies times the reliability in the
 * authority's fleet view (1 with no fresh view). The order itself is L03's
 * `rankMembers`; nothing here re-implements it. Private to L04.
 */
import { clone, create } from "@bufbuild/protobuf";
import {
	type FleetRecord,
	MemberKind,
	type MemberRecord,
	MemberState,
	type Observation,
	Role,
	SandboxTier,
	WorkNeedsSchema,
	type WorkOffer,
} from "../_generated/fleet_pb.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseMemberId,
	type WorkDigest,
} from "../ids.js";
import {
	acceptObservation,
	fitWork,
	rankMembers,
} from "../observation/index.js";
import type { FleetBus, KeyedEnvelope, RegistryView } from "../ports.js";
import { policyOf } from "./checks.js";
import { neededTier, residencyAllows, versionAtLeast } from "./rules.js";

/** How many observations one read takes from the board. */
const BOARD_LIMIT = 4_096;

export type Candidate = Readonly<{
	memberId: MemberId;
	record: MemberRecord;
	observation: Observation;
	copies: number;
}>;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The accepted observations of devices about themselves, kept across reads:
 * an envelope already accepted is reused (acceptance refuses a second sight of
 * the same `issued_at` as a replay), and an expired one is dropped before
 * anything is ranked on it.
 */
export function createObservationCache(registry: RegistryView) {
	const accepted = new Map<
		string,
		Readonly<{
			signature: Uint8Array;
			issuedAtMs: number;
			observation: Observation;
		}>
	>();

	async function admit(keyed: KeyedEnvelope, nowMs: number): Promise<void> {
		const key = `${keyed.observerId}.${keyed.memberId}`;
		const known = accepted.get(key);
		if (
			known !== undefined &&
			sameBytes(known.signature, keyed.envelope.signature)
		)
			return;
		const outcome = await acceptObservation(
			keyed,
			registry,
			known?.issuedAtMs,
			nowMs,
		);
		if (!outcome.ok) return;
		accepted.set(key, {
			signature: keyed.envelope.signature.slice(),
			issuedAtMs: Date.parse(outcome.value.issuedAt),
			observation: outcome.value,
		});
	}

	return {
		/** Reads the board and returns the live self-observations by member. */
		async read(
			board: FleetBus["observations"],
			nowMs: number,
		): Promise<ReadonlyMap<MemberId, Observation>> {
			try {
				const { observations } = await board.read(BOARD_LIMIT);
				for (const keyed of observations)
					if (keyed.observerId === keyed.memberId) await admit(keyed, nowMs);
			} catch {
				// The board is down: rank on what was accepted before, while it lasts.
			}
			const live = new Map<MemberId, Observation>();
			for (const [key, entry] of accepted) {
				if (Date.parse(entry.observation.validUntil) <= nowMs) {
					accepted.delete(key);
					continue;
				}
				live.set(parseMemberId(entry.observation.memberId), entry.observation);
			}
			return live;
		},
	};
}

/** The copies of this offer one device could run, or 0 when it may not or cannot take it. */
export function copiesFor(
	offer: WorkOffer,
	record: MemberRecord,
	observation: Observation,
	fleet: FleetRecord,
): number {
	const policy = policyOf(fleet.policy);
	if (record.kind !== MemberKind.DEVICE || record.state !== MemberState.ACTIVE)
		return 0;
	if (
		!record.memberships.some(
			(membership) =>
				membership.fleet === fleet.fleetId &&
				membership.roles.includes(Role.EXECUTOR),
		)
	)
		return 0;
	if (!observation.fleets.includes(fleet.fleetId)) return 0;
	const version = observation.agentVersion || record.agentVersion;
	if (!versionAtLeast(version, policy.minAgentVersion)) return 0;
	const region = observation.region || record.region;
	if (!residencyAllows(region, [policy.residency, offer.residency])) return 0;
	const { tier } = neededTier(offer, record, policy);
	if (tier === "never") return 0;
	const needs = clone(WorkNeedsSchema, offer.needs ?? create(WorkNeedsSchema));
	needs.minSandbox =
		tier === SandboxTier.UNSPECIFIED ? SandboxTier.S1_CONTAINER : tier;
	const fit = fitWork(observation, needs);
	return fit.fits ? fit.copies : 0;
}

/** The fleet's executors for this offer, best first, and why each is there. */
export async function rankExecutors(
	input: Readonly<{
		registry: RegistryView;
		fleet: FleetRecord;
		offer: WorkOffer;
		digest: WorkDigest;
		observations: ReadonlyMap<MemberId, Observation>;
		/** The caller's own figures, used when it has no observation of itself on the board. */
		self?: Readonly<{ memberId: MemberId; observation: Observation }>;
	}>,
): Promise<
	Readonly<{ ranked: readonly MemberId[]; candidates: readonly Candidate[] }>
> {
	const view = await input.registry
		.view(parseFleetId(input.fleet.fleetId))
		.catch(() => undefined);
	const reliability = new Map<string, number>();
	for (const member of view?.members ?? [])
		if (member.reliability !== undefined)
			reliability.set(member.memberId, member.reliability);
	const observations = new Map(input.observations);
	if (input.self !== undefined && !observations.has(input.self.memberId))
		observations.set(input.self.memberId, input.self.observation);
	const candidates: Candidate[] = [];
	for (const [memberId, observation] of observations) {
		const record = await input.registry.member(memberId);
		if (record === undefined) continue;
		const copies = copiesFor(input.offer, record, observation, input.fleet);
		if (copies > 0) candidates.push({ memberId, record, observation, copies });
	}
	const ranked = rankMembers(
		input.digest,
		candidates.map((candidate) => ({
			memberId: candidate.memberId,
			copies: candidate.copies,
			reliability: reliability.get(candidate.memberId) ?? 1,
		})),
	);
	return { ranked, candidates };
}

/** The fleet's active dispatchers, ranked the same way by every one of them (§6.9 "No single point of failure"). */
export async function rankDispatchers(
	registry: RegistryView,
	fleet: FleetId,
	digest: WorkDigest,
): Promise<readonly MemberId[]> {
	const members = await registry.membersOf(fleet);
	return rankMembers(
		digest,
		members
			.filter(
				(member) =>
					member.kind === MemberKind.DEVICE &&
					member.state === MemberState.ACTIVE &&
					member.memberships.some(
						(membership) =>
							membership.fleet === fleet &&
							membership.roles.includes(Role.DISPATCHER),
					),
			)
			.map((member) => ({
				memberId: parseMemberId(member.memberId),
				copies: 1,
				reliability: 1,
			})),
	);
}
