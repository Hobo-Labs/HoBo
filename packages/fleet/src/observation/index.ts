import type {
	FleetRecord,
	FleetVerdict,
	FleetView,
	MemberRecord,
	Observation,
	ReliabilitySamples,
	SignedEnvelope,
	WorkNeeds,
	WorkReceipt,
} from "../_generated/fleet_pb.js";
import type { MemberId, WorkDigest } from "../ids.js";
import type {
	EligibleMember,
	KeyedEnvelope,
	NamedObservation,
	Outcome,
	RegistryView,
	Signer,
} from "../ports.js";
import { accept, build } from "./accept.js";
import { eligibility, failing, fitObservation } from "./health.js";
import { reliabilityLedger } from "./reliability.js";
import { leader, rank, turn } from "./rendezvous.js";
import { buildFleetVerdict, buildFleetView } from "./view.js";

export function buildObservation(
	input: Observation,
	signer: Signer | undefined,
): Promise<SignedEnvelope | Observation> {
	return build(input, signer);
}

export function acceptObservation(
	keyed: KeyedEnvelope,
	registry: RegistryView,
	lastIssuedAtMs: number | undefined,
	nowMs: number,
): Promise<Outcome<Observation>> {
	return accept(keyed, registry, lastIssuedAtMs, nowMs);
}

export function fitWork(
	observation: Observation,
	needs: WorkNeeds,
): Readonly<
	| { fits: true; copies: number }
	| {
			fits: false;
			lacking:
				| "slot"
				| "memory"
				| "disk"
				| "platform"
				| "label"
				| "sandbox"
				| "docker";
	  }
> {
	return fitObservation(observation, needs);
}

export function failingLongerThan(
	observation: Observation,
	ms: number,
): boolean {
	return failing(observation, ms);
}

export function eligibleForActive(
	observations: readonly NamedObservation[],
	options: Readonly<{
		mode: "failover" | "switch";
		recoveryPointMs: number | undefined;
	}>,
): readonly EligibleMember[] {
	return eligibility(observations, options.mode, options.recoveryPointMs);
}

export function rankMembers(
	digest: WorkDigest,
	candidates: readonly Readonly<{
		memberId: MemberId;
		copies: number;
		reliability: number;
	}>[],
): readonly MemberId[] {
	return rank(digest, candidates);
}

export function leaderOf(
	ranked: readonly MemberId[],
	self: MemberId,
): MemberId {
	return leader(ranked, self);
}

export function claimTurn(
	input: Readonly<{
		digest: WorkDigest;
		self: MemberId;
		ranked: readonly MemberId[];
		queuedAtMs: number;
		nowMs: number;
		stepMs: number;
		maxRank: number;
	}>,
): Readonly<{ rank: number; waitMs: number }> {
	return turn(input);
}

export function fleetView(
	fleet: FleetRecord,
	members: readonly MemberRecord[],
	observations: readonly Observation[],
	reliability: ReadonlyMap<MemberId, ReliabilitySamples>,
	nowMs: number,
): FleetView {
	return buildFleetView(fleet, members, observations, reliability, nowMs);
}

export function fleetVerdict(
	view: FleetView,
	label: string,
	nowMs: number,
): FleetVerdict {
	return buildFleetVerdict(view, label, nowMs);
}

export function createReliabilityLedger(
	options?: Readonly<{ halfLifeMs: number }>,
): Readonly<{
	record(receipt: WorkReceipt): void;
	samples(): ReadonlyMap<MemberId, ReliabilitySamples>;
}> {
	return reliabilityLedger(options?.halfLifeMs);
}
