import { clone, create, toJson } from "@bufbuild/protobuf";
import {
	isBoundedPricingInput,
	isExactProtoMessage,
	quoteTargetPricing,
	stableHash,
	type TargetPricingAvailability,
	TargetPricingAvailabilitySchema,
	type TargetPricingInventory,
	TargetPricingInventorySchema,
} from "@hobo/pricing";
import {
	type IacTargetAdmissionDecision,
	IacTargetAdmissionDecisionSchema,
	type IacUnpricedPolicyProof,
	IacUnpricedPolicyProofSchema,
	type IacUnpricedScopeProof,
	IacUnpricedScopeProofSchema,
} from "./_generated/yard_placement_pb.js";
import {
	BudgetAdmissionDeniedError,
	type BudgetIdentity,
	BudgetIdentitySchema,
	type BudgetReservation,
	BudgetReservationSchema,
	budgetIdentityKey,
} from "./budget-authority.js";
import type { IacTargetAdmissionDeps } from "./iac-target.js";
import type { GateDecision } from "./planes.js";

export interface IacUnpricedAuthorizationInput {
	readonly requestId: string;
	readonly requestDigest: string;
	readonly inventoryHash: string;
	readonly inventory: TargetPricingInventory;
	readonly identity: BudgetIdentity;
	readonly now: string;
}

/** A trusted host must explicitly authorize budget bypass for this exact target. */
export type IacUnpricedAuthorizer = (input: IacUnpricedAuthorizationInput) =>
	| {
			gate: GateDecision;
			proof: IacUnpricedPolicyProof;
			scopeProof: IacUnpricedScopeProof;
	  }
	| Promise<{
			gate: GateDecision;
			proof: IacUnpricedPolicyProof;
			scopeProof: IacUnpricedScopeProof;
	  }>;

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function denied(
	requestId: string,
	targetId: string,
	code: string,
	message: string,
	policy = false,
): IacTargetAdmissionDecision {
	return create(IacTargetAdmissionDecisionSchema, {
		requestId,
		targetId,
		status: "denied",
		code,
		message,
		budget: {
			evaluation: policy ? "denied" : "unavailable",
			reservation: "not-created",
		},
	});
}

function uncertain(
	requestId: string,
	targetId: string,
	code: string,
	state: "unknown" | "held" | "uncertain",
	requestDigest = "",
): IacTargetAdmissionDecision {
	const result = create(IacTargetAdmissionDecisionSchema, {
		requestId,
		targetId,
		status: "uncertain",
		code,
		requestDigest,
		message: "unbounded exposure must be reconciled before execution or retry",
		budget: { evaluation: "unavailable", reservation: state },
	});
	if (state !== "unknown")
		result.reservation = create(BudgetReservationSchema, {
			reservationId: `iac:${requestId}`,
			unboundedExposure: true,
		});
	return result;
}

/** Admit an explicitly selected unpriced target without claiming a financial bound. */
export async function admitUnpricedIacTarget(
	input: {
		requestId: string;
		inventory: TargetPricingInventory;
		pricing: TargetPricingAvailability;
	},
	deps: Pick<IacTargetAdmissionDeps, "authority" | "now"> & {
		authorizeUnpriced: IacUnpricedAuthorizer;
	},
): Promise<IacTargetAdmissionDecision> {
	const { requestId } = input;
	const targetId = input.inventory.targetId;
	if (
		!name(requestId) ||
		!isBoundedPricingInput(input.inventory) ||
		!isBoundedPricingInput(input.pricing)
	)
		return denied(
			requestId,
			targetId,
			"REQUEST_INVALID",
			"a bounded request and target are required",
		);
	if (!isExactProtoMessage(TargetPricingAvailabilitySchema, input.pricing))
		return denied(
			requestId,
			targetId,
			"PRICING_INPUT_INVALID",
			"target pricing input contains unsupported or malformed data",
		);
	let inventory: TargetPricingInventory;
	let pricing: TargetPricingAvailability;
	try {
		inventory = clone(TargetPricingInventorySchema, input.inventory);
		pricing = clone(TargetPricingAvailabilitySchema, input.pricing);
	} catch {
		return denied(
			requestId,
			targetId,
			"PRICING_INPUT_INVALID",
			"target pricing input is malformed",
		);
	}
	const priced = quoteTargetPricing(inventory, pricing);
	if (
		priced.ok ||
		priced.code !== "PRICING_MODEL_UNAVAILABLE" ||
		pricing.state.case !== "unavailable"
	)
		return denied(
			requestId,
			targetId,
			"UNPRICED_SCOPE_INVALID",
			"only an explicitly unpriced complete target may bypass budget evaluation",
		);
	if (inventory.operation !== "deploy" && inventory.operation !== "destroy")
		return denied(
			requestId,
			targetId,
			"UNPRICED_SCOPE_INVALID",
			"the intended infrastructure operation is required",
		);
	if (deps.authority.persistence !== "durable-cas")
		return denied(
			requestId,
			targetId,
			"BUDGET_AUTHORITY_UNAVAILABLE",
			"a durable shared authority is required to track unbounded exposure",
		);
	const inventoryHash = stableHash(
		toJson(TargetPricingInventorySchema, inventory, {
			alwaysEmitImplicit: true,
		}),
	);
	const requestDigest = stableHash({
		kind: "iac-unpriced",
		requestId,
		targetId,
		tenantId: inventory.tenantId,
		inventoryHash,
	});
	let currentTime: string;
	let ledger: Awaited<ReturnType<IacTargetAdmissionDeps["authority"]["read"]>>;
	try {
		currentTime = deps.now();
		if (!Number.isFinite(Date.parse(currentTime)))
			throw new Error("invalid clock");
		ledger = await deps.authority.read(currentTime);
	} catch {
		return denied(
			requestId,
			targetId,
			"BUDGET_AUTHORITY_UNAVAILABLE",
			"budget exposure or trusted time is unavailable",
		);
	}
	const identity = ledger.identity;
	if (identity === undefined || identity.tenantId !== inventory.tenantId)
		return denied(
			requestId,
			targetId,
			"BUDGET_SCOPE_MISMATCH",
			"the budget authority belongs to another tenant",
		);
	let policy: {
		gate: GateDecision;
		proof: IacUnpricedPolicyProof;
		scopeProof: IacUnpricedScopeProof;
	};
	let proof: IacUnpricedPolicyProof;
	let scopeProof: IacUnpricedScopeProof;
	let authorized: boolean;
	try {
		policy = await deps.authorizeUnpriced({
			requestId,
			requestDigest,
			inventoryHash,
			now: currentTime,
			inventory: clone(TargetPricingInventorySchema, inventory),
			identity: clone(BudgetIdentitySchema, identity),
		});
		if (!policy || !isBoundedPricingInput(policy))
			throw new Error("malformed policy decision");
		policy = structuredClone(policy);
		if (
			!policy.gate ||
			!isExactProtoMessage(IacUnpricedPolicyProofSchema, policy.proof) ||
			!isExactProtoMessage(IacUnpricedScopeProofSchema, policy.scopeProof)
		)
			throw new Error("malformed policy decision");
		proof = clone(IacUnpricedPolicyProofSchema, policy.proof);
		scopeProof = clone(IacUnpricedScopeProofSchema, policy.scopeProof);
		authorized =
			(policy.gate?.effect === "allow" ||
				policy.gate?.effect === "allow-degraded") &&
			proof.effect === policy.gate.effect &&
			proof.obligationsSatisfied === true &&
			proof.requestDigest === requestDigest &&
			proof.inventoryHash === inventoryHash &&
			proof.identity !== undefined &&
			budgetIdentityKey(proof.identity) === budgetIdentityKey(identity) &&
			name(proof.policyHash) &&
			name(proof.evidenceRef) &&
			Number.isFinite(Date.parse(proof.observedAt)) &&
			Number.isFinite(Date.parse(proof.validUntil)) &&
			Date.parse(proof.observedAt) <= Date.parse(currentTime) &&
			Date.parse(proof.validUntil) > Date.parse(currentTime);
	} catch {
		return denied(
			requestId,
			targetId,
			"UNPRICED_POLICY_UNAVAILABLE",
			"unpriced policy authorization failed",
		);
	}
	if (!authorized)
		return denied(
			requestId,
			targetId,
			"UNPRICED_POLICY_NOT_ALLOWED",
			"policy denied, expired, requires approval, or has unfulfilled obligations",
			true,
		);
	const reservationId = `iac:${requestId}`;
	const accounts = [
		...new Set(
			inventory.resources.map((resource) => resource.providerAccountRef),
		),
	].sort();
	const entitlementKeys = ledger.entitlements
		.map((row) => JSON.stringify([row.bucketId, row.unit]))
		.sort();
	const validReservation = (value: BudgetReservation): boolean => {
		try {
			return (
				value.reservationId === reservationId &&
				value.unboundedExposure &&
				value.requestDigest === requestDigest &&
				value.financialPlanHash === inventoryHash &&
				value.identity !== undefined &&
				budgetIdentityKey(value.identity) === budgetIdentityKey(identity) &&
				value.quoteId === "" &&
				value.reservedMicros === 0 &&
				value.unpricedPolicyProof !== undefined &&
				value.unpricedScopeProof !== undefined &&
				JSON.stringify(
					toJson(IacUnpricedPolicyProofSchema, value.unpricedPolicyProof, {
						alwaysEmitImplicit: true,
					}),
				) ===
					JSON.stringify(
						toJson(IacUnpricedPolicyProofSchema, proof, {
							alwaysEmitImplicit: true,
						}),
					) &&
				JSON.stringify(
					toJson(IacUnpricedScopeProofSchema, value.unpricedScopeProof, {
						alwaysEmitImplicit: true,
					}),
				) ===
					JSON.stringify(
						toJson(IacUnpricedScopeProofSchema, scopeProof, {
							alwaysEmitImplicit: true,
						}),
					) &&
				JSON.stringify(
					value.providerAccounts
						.map((account) => account.providerAccountId)
						.sort(),
				) === JSON.stringify(accounts) &&
				value.providerAccounts.every(
					(account) => account.liabilityMicros === 0,
				) &&
				JSON.stringify(
					value.entitlementClaims
						.map((claim) => JSON.stringify([claim.bucketId, claim.unit]))
						.sort(),
				) === JSON.stringify(entitlementKeys) &&
				value.entitlementClaims.every((claim) => claim.units === 0)
			);
		} catch {
			return false;
		}
	};
	let reservation: Awaited<
		ReturnType<IacTargetAdmissionDeps["authority"]["reserveUnbounded"]>
	>;
	try {
		reservation = clone(
			BudgetReservationSchema,
			await deps.authority.reserveUnbounded({
				reservationId,
				requestDigest,
				inventoryHash,
				policyProof: proof,
				scopeProof,
				identity,
				expectedSeq: ledger.seq,
				now: deps.now(),
				providerAccountIds: accounts,
			}),
		);
	} catch (error) {
		if (error instanceof BudgetAdmissionDeniedError)
			return denied(requestId, targetId, error.code, error.message, true);
		return uncertain(
			requestId,
			targetId,
			"UNPRICED_RESERVATION_OUTCOME_UNKNOWN",
			"unknown",
			requestDigest,
		);
	}
	if (!validReservation(reservation))
		return uncertain(
			requestId,
			targetId,
			"UNPRICED_RECEIPT_INVALID",
			"unknown",
			requestDigest,
		);
	if (reservation.status !== "held")
		return uncertain(
			requestId,
			targetId,
			"UNPRICED_RESERVATION_UNCERTAIN",
			reservation.status === "uncertain" ? "uncertain" : "unknown",
			requestDigest,
		);
	const executionDigest = stableHash({
		kind: "iac-target-execution",
		requestDigest,
		planDigest: inventory.planDigest,
	});
	if (reservation.executionDigest) {
		if (reservation.executionDigest !== executionDigest)
			return uncertain(
				requestId,
				targetId,
				"EXECUTION_CLAIM_CONFLICT",
				"held",
				requestDigest,
			);
		return create(IacTargetAdmissionDecisionSchema, {
			requestId,
			targetId,
			status: "replay",
			code: "EXECUTION_ALREADY_CLAIMED",
			requestDigest,
			inventoryHash,
			budget: { evaluation: "bypassed", reservation: "held" },
			reservation,
			unpricedPolicyProof: proof,
		});
	}
	try {
		const claimAt = deps.now();
		const head = await deps.authority.read(claimAt);
		const claimed = clone(
			BudgetReservationSchema,
			await deps.authority.claimExecution({
				reservationId,
				requestDigest,
				executionDigest,
				expectedSeq: head.seq,
				now: claimAt,
			}),
		);
		if (
			!validReservation(claimed) ||
			claimed.status !== "held" ||
			claimed.executionDigest !== executionDigest
		)
			return uncertain(
				requestId,
				targetId,
				"UNPRICED_RECEIPT_INVALID",
				"held",
				requestDigest,
			);
		if (claimed.ledgerSeq !== head.seq + 1)
			return create(IacTargetAdmissionDecisionSchema, {
				requestId,
				targetId,
				status: "replay",
				code: "EXECUTION_ALREADY_CLAIMED",
				requestDigest,
				inventoryHash,
				budget: { evaluation: "bypassed", reservation: "held" },
				reservation: claimed,
				unpricedPolicyProof: proof,
			});
		reservation = claimed;
		const after = Date.parse(deps.now());
		if (!Number.isFinite(after) || after >= Date.parse(proof.validUntil))
			return uncertain(
				requestId,
				targetId,
				"UNPRICED_POLICY_EXPIRED_AFTER_CLAIM",
				"held",
				requestDigest,
			);
	} catch {
		return uncertain(
			requestId,
			targetId,
			"EXECUTION_CLAIM_UNCERTAIN",
			"held",
			requestDigest,
		);
	}
	return create(IacTargetAdmissionDecisionSchema, {
		requestId,
		targetId,
		status: "admitted",
		requestDigest,
		inventoryHash,
		budget: { evaluation: "bypassed", reservation: "held" },
		reservation,
		unpricedPolicyProof: proof,
	});
}
