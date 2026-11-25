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
		async read(
			board: FleetBus["observations"],
			nowMs: number,
		): Promise<ReadonlyMap<MemberId, Observation>> {
			try {
				const { observations } = await board.read(BOARD_LIMIT);
				for (const keyed of observations)
					if (keyed.observerId === keyed.memberId) await admit(keyed, nowMs);
			} catch {}
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

export async function rankExecutors(
	input: Readonly<{
		registry: RegistryView;
		fleet: FleetRecord;
		offer: WorkOffer;
		digest: WorkDigest;
		observations: ReadonlyMap<MemberId, Observation>;
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
