/**
 * The three checks that stand between a dispatcher and a device (design
 * §6.9): the dispatcher's four claim rules (step 4), the device's order
 * acceptance (step 6) and the start fence (step 7). Private to L04.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	type Claim,
	ClaimSchema,
	CoordinationMode,
	type FleetPolicy,
	FleetPolicySchema,
	MemberKind,
	type MemberRecord,
	MemberState,
	Role,
	SandboxTier,
	type SignedEnvelope,
	type TrustClass,
	type WorkOffer,
	WorkOfferSchema,
	type WorkOrder,
	WorkOrderSchema,
} from "../_generated/fleet_pb.js";
import { CLAIM_CONTEXT, ORDER_CONTEXT } from "../contexts.js";
import type { FleetErrorCode } from "../errors.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseMemberId,
	type WorkDigest,
} from "../ids.js";
import { claimTurn } from "../observation/index.js";
import type { ObservedAssignment, Outcome, RegistryView } from "../ports.js";
import {
	digestOf,
	neededTier,
	policyRefusal,
	residencyAllows,
	sandboxFor,
	submissionOf,
	trustClassOf,
} from "./rules.js";
import { authoritySigned, deviceSigner } from "./signed.js";

/** §6.9 step 2: ranks are capped at 4. */
export const MAX_RANK = 4;

export type ClaimVerdict = "valid" | "discard" | "not-entitled" | "early";

function decodeClaim(payload: Uint8Array): Claim | undefined {
	try {
		return fromBinary(ClaimSchema, payload);
	} catch {
		return undefined;
	}
}

function timeOf(value: string): number | undefined {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function hasRole(record: MemberRecord, fleet: string, role: Role): boolean {
	return record.memberships.some(
		(membership) =>
			membership.fleet === fleet && membership.roles.includes(role),
	);
}

function differs(wanted: string | undefined, has: string | undefined): boolean {
	return (
		wanted !== undefined &&
		wanted !== "" &&
		has !== undefined &&
		has !== "" &&
		wanted !== has
	);
}

/**
 * Whether the claimant may hold this work at all, from the registry alone
 * (§6.9 step 4, second rule): `ACTIVE`, an executor in the fleet, on the
 * platform the work names, in a region the residency rules admit, and
 * claiming a tier at least what §6.11 requires for the class it derives.
 * Capacity is advice (§6.8) and is never grounds for a report.
 */
function entitled(
	claimant: MemberRecord,
	claim: Claim,
	offer: WorkOffer,
	policy: FleetPolicy,
): boolean {
	if (claimant.kind !== MemberKind.DEVICE) return false;
	if (claimant.state !== MemberState.ACTIVE) return false;
	if (!hasRole(claimant, offer.fleet, Role.EXECUTOR)) return false;
	if (
		differs(offer.needs?.platform?.os, claimant.platform?.os) ||
		differs(offer.needs?.platform?.arch, claimant.platform?.arch)
	)
		return false;
	if (!residencyAllows(claimant.region, [policy.residency, offer.residency]))
		return false;
	const { tier } = neededTier(offer, claimant, policy);
	return tier !== "never" && claim.sandboxTier >= tier;
}

/**
 * The claimant's rank: its place in the dispatcher's own ranking, or, where
 * the caller has no ranking (the authority re-checking a report) or the
 * ranking leaves it out, the rank the claimant signed into its claim.
 */
function earlyBy(
	claim: Claim,
	digest: WorkDigest,
	claimant: MemberId,
	offer: WorkOffer,
	context: Readonly<{
		ranked: readonly MemberId[];
		nowMs: number;
		stepMs: number;
	}>,
): boolean {
	const queuedAtMs = timeOf(offer.queuedAt);
	if (queuedAtMs === undefined) return false;
	// The device's own signed time, unless it is in the reader's future.
	const at = Math.min(context.nowMs, timeOf(claim.claimedAt) ?? context.nowMs);
	if (context.ranked.includes(claimant)) {
		const turn = claimTurn({
			digest,
			self: claimant,
			ranked: context.ranked,
			queuedAtMs,
			nowMs: at,
			stepMs: context.stepMs,
			maxRank: MAX_RANK,
		});
		return turn.waitMs > context.stepMs;
	}
	const rank = Math.min(claim.rank, MAX_RANK);
	return queuedAtMs + rank * context.stepMs - at > context.stepMs;
}

/** §6.9 step 4, in order: discard, not entitled, early, or valid. */
export async function claimVerdict(
	envelope: SignedEnvelope,
	subject: Readonly<{ fleet: FleetId; digest: WorkDigest }>,
	offer: WorkOffer,
	context: Readonly<{
		registry: RegistryView;
		ranked: readonly MemberId[];
		nowMs: number;
		stepMs: number;
	}>,
): Promise<ClaimVerdict> {
	// Rule 1: anyone can publish garbage or replay a claim, so nothing is attributed.
	const claimant = await deviceSigner(
		context.registry,
		envelope,
		CLAIM_CONTEXT,
	);
	if (claimant === undefined) return "discard";
	const claim = decodeClaim(envelope.payload);
	if (
		claim === undefined ||
		claim.memberId !== claimant.memberId ||
		claim.fleet !== subject.fleet ||
		claim.fleet !== offer.fleet ||
		claim.workDigest !== subject.digest ||
		claim.workDigest !== offer.workDigest ||
		claim.dispatcher !== offer.dispatcher ||
		claim.offerExpiresAt !== offer.expiresAt
	)
		return "discard";
	const fleet = await context.registry.fleet(subject.fleet);
	if (fleet === undefined) return "discard";
	// Rule 2: the claimant's own signature proves it claimed what it may not hold.
	if (!entitled(claimant, claim, offer, policyOf(fleet.policy)))
		return "not-entitled";
	// Rule 3: more than one rank ahead of its turn.
	if (
		earlyBy(
			claim,
			subject.digest,
			parseMemberId(claimant.memberId),
			offer,
			context,
		)
	)
		return "early";
	return "valid";
}

/** A fleet record without a policy has the empty one. */
export function policyOf(policy: FleetPolicy | undefined): FleetPolicy {
	return policy ?? create(FleetPolicySchema);
}

export type OrderCheck =
	| "context"
	| "signer"
	| "payload"
	| "dispatcher"
	| "recipient"
	| "digest"
	| "claim"
	| "replayed"
	| "expired"
	| "fleet"
	| PolicyCheck
	| "submission"
	| "residency"
	| "sandbox";
type PolicyCheck = "kind" | "repository" | "ref" | "workflow";

/** The checks after which the order is attributable to its dispatcher and this device answers it with a receipt. */
export const ATTRIBUTABLE: ReadonlySet<OrderCheck> = new Set<OrderCheck>([
	"digest",
	"claim",
	"expired",
	"fleet",
	"kind",
	"repository",
	"ref",
	"workflow",
	"submission",
	"residency",
	"sandbox",
]);

function refused<T>(
	code: FleetErrorCode,
	check: OrderCheck,
	message: string,
	orderId = "",
): Outcome<T> {
	return {
		ok: false,
		error: { code, message, detail: { check, order: orderId } },
	};
}

/** §6.9 step 6: every acceptance rule, each refusal naming its rule in `detail.check`. */
export async function orderVerdict(
	envelope: SignedEnvelope,
	context: Readonly<{
		self: MemberRecord;
		registry: RegistryView;
		heldClaims: ReadonlySet<WorkDigest>;
		seenOrderIds: ReadonlySet<string>;
		nowMs: number;
	}>,
): Promise<
	Outcome<Readonly<{ order: WorkOrder; trust: TrustClass; tier: SandboxTier }>>
> {
	if (envelope.context !== ORDER_CONTEXT)
		return refused("order-invalid", "context", "not an order");
	const dispatcher = await deviceSigner(
		context.registry,
		envelope,
		ORDER_CONTEXT,
	);
	if (dispatcher === undefined)
		return refused(
			"order-invalid",
			"signer",
			"the order is not signed by a known device",
		);
	let order: WorkOrder;
	try {
		order = fromBinary(WorkOrderSchema, envelope.payload);
	} catch {
		return refused("order-invalid", "payload", "the order does not decode");
	}
	const offer = order.offer;
	if (offer === undefined)
		return refused("order-invalid", "payload", "the order carries no offer");
	const id = order.orderId;
	if (
		dispatcher.kind !== MemberKind.DEVICE ||
		dispatcher.state !== MemberState.ACTIVE ||
		!hasRole(dispatcher, offer.fleet, Role.DISPATCHER) ||
		offer.dispatcher !== dispatcher.memberId
	)
		return refused(
			"order-invalid",
			"dispatcher",
			"the signer is not a dispatcher of that fleet",
			id,
		);
	if (order.memberId !== context.self.memberId)
		return refused(
			"order-invalid",
			"recipient",
			"the order names another device",
			id,
		);
	if (context.seenOrderIds.has(id) || !/^[0-9a-f]{32}$/u.test(id))
		return refused(
			"order-invalid",
			"replayed",
			"the order id was seen before",
			id,
		);
	const digest = digestOf(offer.kind, offer.workKey);
	if (offer.workDigest !== digest)
		return refused(
			"order-invalid",
			"digest",
			"the work digest does not match the work",
			id,
		);
	if (!context.heldClaims.has(digest))
		return refused(
			"order-invalid",
			"claim",
			"this device holds no claim for that work",
			id,
		);
	const offerExpiry = timeOf(offer.expiresAt);
	const orderExpiry = timeOf(order.expiresAt);
	if (
		offerExpiry === undefined ||
		offerExpiry <= context.nowMs ||
		(orderExpiry !== undefined && orderExpiry <= context.nowMs)
	)
		return refused("order-invalid", "expired", "the offer has expired", id);
	let fleetId: FleetId;
	try {
		fleetId = parseFleetId(offer.fleet);
	} catch {
		return refused("order-invalid", "fleet", "the fleet is unknown", id);
	}
	const fleet = await context.registry.fleet(fleetId);
	if (
		fleet === undefined ||
		fleet.coordination === CoordinationMode.ONE_ACTIVE ||
		!context.self.memberships.some(
			(membership) =>
				membership.fleet === offer.fleet &&
				membership.roles.includes(Role.EXECUTOR),
		)
	)
		return refused(
			"order-invalid",
			"fleet",
			"this device is not an executor of that fleet",
			id,
		);
	const policy = policyOf(fleet.policy);
	const policyCheck = policyRefusal(policy, offer);
	if (policyCheck !== undefined)
		return refused(
			"order-invalid",
			policyCheck,
			`fleet policy does not allow the ${policyCheck}`,
			id,
		);
	if (offer.submission !== undefined || offer.kind === OCI_COMMAND) {
		const submission = submissionOf(offer);
		if (
			offer.submission === undefined ||
			submission === undefined ||
			!authoritySigned(offer.submission, context.registry.trust()) ||
			submission.fleet !== offer.fleet ||
			submission.author !== offer.author ||
			(timeOf(submission.expiresAt) ?? 0) <= context.nowMs
		)
			return refused(
				"order-invalid",
				"submission",
				"the submission does not verify against the authority",
				id,
			);
	}
	if (
		!residencyAllows(context.self.region, [policy.residency, offer.residency])
	)
		return refused(
			"residency-denied",
			"residency",
			"this device's region is outside the residency rule",
			id,
		);
	const { trust, tier } = neededTier(offer, context.self, policy);
	if (tier === "never" || order.sandboxTier < tier)
		return refused(
			"sandbox-inadequate",
			"sandbox",
			"the order's sandbox tier is below what this work needs here",
			id,
		);
	return { ok: true, value: { order, trust, tier: order.sandboxTier } };
}

// public-contract: the work kind of submitted OCI commands (§6.9 table).
export const OCI_COMMAND = "oci-command";

/**
 * §6.9 step 7: the start fence. The repository GitHub reports must be the
 * order's, the ref must be one fleet policy allows, and the tier the device is
 * running must still be adequate for the trust class re-derived from the
 * observed author and origin (the order's class is a ceiling only).
 */
export function fenceAllows(
	order: WorkOrder,
	observed: ObservedAssignment,
	self: MemberRecord,
	policy: FleetPolicy,
	tier: SandboxTier,
): boolean {
	const offer = order.offer;
	if (offer === undefined) return false;
	if (observed.repository !== offer.repository) return false;
	if (
		policyRefusal(policy, {
			kind: offer.kind,
			repository: observed.repository,
			ref: observed.ref,
			workflowDigest: offer.workflowDigest,
		}) !== undefined
	)
		return false;
	// The facts GitHub reports replace the dispatcher's; its class stays a ceiling.
	const facts = create(WorkOfferSchema, {
		trustClass: offer.trustClass,
		author: observed.author,
		origin: observed.origin,
	});
	const trust = trustClassOf(facts, self);
	const required = sandboxFor(
		trust,
		self.deviceClass,
		policy,
		observed.repository,
	);
	if (required === "never") return false;
	const floor = offer.needs?.minSandbox ?? SandboxTier.UNSPECIFIED;
	return tier >= required && tier >= floor;
}
