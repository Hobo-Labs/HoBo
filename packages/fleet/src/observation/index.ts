/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/observation` (L03): signed observations, fit, one-active
 * eligibility, ranking and claim turns, fleet views and verdicts, and the
 * reliability ledger (§6.8).
 *
 * Contract commit: every body throws `FleetNotImplemented`; L03 replaces them.
 */
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
import { FleetNotImplemented } from "../errors.js";
import type { MemberId, WorkDigest } from "../ids.js";
import type {
	EligibleMember,
	KeyedEnvelope,
	NamedObservation,
	Outcome,
	RegistryView,
	Signer,
} from "../ports.js";

export function buildObservation(
	input: Observation,
	signer: Signer | undefined,
): Promise<SignedEnvelope | Observation> {
	throw new FleetNotImplemented("buildObservation");
}

export function acceptObservation(
	keyed: KeyedEnvelope,
	registry: RegistryView,
	lastIssuedAtMs: number | undefined,
	nowMs: number,
): Promise<Outcome<Observation>> {
	throw new FleetNotImplemented("acceptObservation");
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
	throw new FleetNotImplemented("fitWork");
}

export function failingLongerThan(
	observation: Observation,
	ms: number,
): boolean {
	throw new FleetNotImplemented("failingLongerThan");
}

/** One answer per observation, in input order; the rules of §6.8. */
export function eligibleForActive(
	observations: readonly NamedObservation[],
	options: Readonly<{
		mode: "failover" | "switch";
		recoveryPointMs: number | undefined;
	}>,
): readonly EligibleMember[] {
	throw new FleetNotImplemented("eligibleForActive");
}

export function rankMembers(
	digest: WorkDigest,
	candidates: readonly Readonly<{
		memberId: MemberId;
		copies: number;
		reliability: number;
	}>[],
): readonly MemberId[] {
	throw new FleetNotImplemented("rankMembers");
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
	throw new FleetNotImplemented("claimTurn");
}

export function fleetView(
	fleet: FleetRecord,
	members: readonly MemberRecord[],
	observations: readonly Observation[],
	reliability: ReadonlyMap<MemberId, ReliabilitySamples>,
	nowMs: number,
): FleetView {
	throw new FleetNotImplemented("fleetView");
}

export function fleetVerdict(
	view: FleetView,
	label: string,
	nowMs: number,
): FleetVerdict {
	throw new FleetNotImplemented("fleetVerdict");
}

export function createReliabilityLedger(
	options?: Readonly<{ halfLifeMs: number }>,
): Readonly<{
	record(receipt: WorkReceipt): void;
	samples(): ReadonlyMap<MemberId, ReliabilitySamples>;
}> {
	throw new FleetNotImplemented("createReliabilityLedger");
}
