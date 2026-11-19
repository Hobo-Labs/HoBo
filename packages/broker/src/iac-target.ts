import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { clone, create, toJson, toJsonString } from "@bufbuild/protobuf";
import {
	type Decimal,
	isBoundedPricingInput,
	isExactProtoMessage,
	isQuoteVector,
	parseDecimal,
	type QuoteScenario,
	QuoteScenarioSchema,
	type QuoteVector,
	QuoteVectorSchema,
	quoteScenarioV2,
	quoteTargetPricing,
	stableHash,
	type TargetPricingAvailability,
	TargetPricingAvailabilitySchema,
	type TargetPricingInventory,
	TargetPricingInventorySchema,
} from "@hobo/pricing";
import {
	type EntitlementClaim,
	IacPricingPinSchema,
	type IacTargetAdmissionDecision,
	IacTargetAdmissionDecisionSchema,
	type IacTargetLiabilityEvidence,
	IacTargetLiabilityEvidenceSchema,
} from "./_generated/yard_placement_pb.js";
import {
	type BudgetAdmissionAuthority,
	BudgetAdmissionDeniedError,
	type BudgetIdentity,
	BudgetIdentitySchema,
	type BudgetReservation,
	BudgetReservationSchema,
	budgetIdentityKey,
	type HostingPolicyProof,
	HostingPolicyProofSchema,
	type HostingQuote,
	HostingQuoteSchema,
	validateHostingQuote,
} from "./budget-authority.js";
import type { AsyncBudgetAdmissionAuthority } from "./budget-postgres.js";
import { incrementalEntitlementClaims } from "./iac-incremental-claims.js";
import { validIacPolicyGate } from "./iac-policy-gate.js";
import type { GateDecision } from "./planes.js";

const hasOwnAdmissionField = Object.hasOwn;
const isAdmissionProxy = utilTypes.isProxy;

export type {
	IacTargetAdmissionDecision,
	IacTargetLiabilityEvidence,
} from "./_generated/yard_placement_pb.js";
export { IacTargetLiabilityEvidenceSchema } from "./_generated/yard_placement_pb.js";

export interface IacTargetAdmissionInput {
	readonly requestId: string;
	readonly inventory: TargetPricingInventory;
	readonly pricing: TargetPricingAvailability;
	readonly evidence?: IacTargetLiabilityEvidence;
}

export interface IacTargetAdmissionDeps {
	readonly authority: BudgetAdmissionAuthority | AsyncBudgetAdmissionAuthority;
	readonly now: () => string;
	readonly verifyLiability: (input: {
		evidence: IacTargetLiabilityEvidence;
		inventory: TargetPricingInventory;
		scenario: QuoteScenario;
		quote: QuoteVector;
	}) => boolean | Promise<boolean>;
	readonly authorize: (input: {
		requestDigest: string;
		quote: HostingQuote;
		identity: BudgetIdentity;
	}) =>
		| { gate: GateDecision; proof: HostingPolicyProof }
		| Promise<{ gate: GateDecision; proof: HostingPolicyProof }>;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function compareIdentifier(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function safeName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the broker validates a potentially untrusted runtime envelope without invoking accessors or proxy traps. */
function captureTargetAdmissionInput(
	input: IacTargetAdmissionInput,
): IacTargetAdmissionInput | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isAdmissionProxy(input) ||
			Array.isArray(input)
		)
			return undefined;
		const keys = Reflect.ownKeys(input);
		if (
			keys.length > 4 ||
			keys.some(
				(key) =>
					typeof key !== "string" ||
					!["requestId", "inventory", "pricing", "evidence"].includes(key),
			)
		)
			return undefined;
		const requestId = Object.getOwnPropertyDescriptor(input, "requestId");
		const inventory = Object.getOwnPropertyDescriptor(input, "inventory");
		const pricing = Object.getOwnPropertyDescriptor(input, "pricing");
		const evidence = Object.getOwnPropertyDescriptor(input, "evidence");
		for (const field of [requestId, inventory, pricing]) {
			if (
				field === undefined ||
				!hasOwnAdmissionField(field, "value") ||
				!field.enumerable
			)
				return undefined;
		}
		if (
			evidence !== undefined &&
			(!hasOwnAdmissionField(evidence, "value") || !evidence.enumerable)
		)
			return undefined;
		if (typeof requestId?.value !== "string") return undefined;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the detached envelope is further validated against the exact protobuf schemas before use.
		const captured = {
			requestId: requestId.value,
			inventory: inventory?.value as TargetPricingInventory,
			pricing: pricing?.value as TargetPricingAvailability,
		};
		if (evidence !== undefined && evidence.value !== undefined)
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the exact liability-evidence schema is checked before use.
			return {
				...captured,
				evidence: evidence.value as IacTargetLiabilityEvidence,
			};
		return captured;
	} catch {
		return undefined;
	}
}

function safeTargetId(inventory: TargetPricingInventory): string {
	try {
		if (
			typeof inventory !== "object" ||
			inventory === null ||
			isAdmissionProxy(inventory) ||
			Array.isArray(inventory)
		)
			return "";
		const field = Object.getOwnPropertyDescriptor(inventory, "targetId");
		return field !== undefined &&
			hasOwnAdmissionField(field, "value") &&
			field.enumerable &&
			typeof field.value === "string" &&
			safeName(field.value)
			? field.value
			: "";
	} catch {
		return "";
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function ceilUnits(value: Decimal, scale: number): number | undefined {
	if (value.coefficient < 0n || value.scale > 128) return undefined;
	const numerator = value.coefficient * 10n ** BigInt(scale);
	const denominator = 10n ** BigInt(value.scale);
	const amount = (numerator + denominator - 1n) / denominator;
	return amount <= MAX_SAFE ? Number(amount) : undefined;
}

function readDecimal(value: string): Decimal | undefined {
	if (value.length > 128) return undefined;
	return parseDecimal(value);
}

function exactInt64Micros(value: bigint): number | undefined {
	return value >= 0n && value <= MAX_SAFE ? Number(value) : undefined;
}

function exactEvidenceMaximumMicros(
	evidence: IacTargetLiabilityEvidence,
): number | undefined {
	const legacyMicros = evidence.maximumMicros;
	const exactMicros =
		evidence.maximumMicrosExact !== undefined
			? exactInt64Micros(evidence.maximumMicrosExact)
			: undefined;
	if (exactMicros !== undefined) {
		if (
			legacyMicros !== undefined &&
			Number.isSafeInteger(legacyMicros) &&
			legacyMicros >= 0 &&
			legacyMicros !== exactMicros
		)
			return undefined;
		return exactMicros;
	}
	return legacyMicros !== undefined &&
		Number.isSafeInteger(legacyMicros) &&
		legacyMicros >= 0
		? legacyMicros
		: undefined;
}

function exactProviderAccountMicros(
	liabilityMicros: number,
): number | undefined {
	return Number.isSafeInteger(liabilityMicros) && liabilityMicros >= 0
		? liabilityMicros
		: undefined;
}

function accountRows(
	rows: IacTargetLiabilityEvidence["providerAccounts"],
): string[] {
	return rows
		.map((row) => JSON.stringify([row.providerAccountId, row.liabilityMicros]))
		.sort();
}

function persistedClaimKind(kind: string): string {
	return kind === "" ? "allowance" : kind;
}

function entitlementRows(
	rows: readonly Pick<
		EntitlementClaim,
		"kind" | "bucketId" | "unit" | "units"
	>[],
): string[] {
	return rows
		.map((row) =>
			JSON.stringify([
				persistedClaimKind(row.kind),
				row.bucketId,
				row.unit,
				row.units,
			]),
		)
		.sort();
}

function totalProviderAccountMicros(
	accounts: IacTargetLiabilityEvidence["providerAccounts"],
): bigint | undefined {
	let totalMicros = 0n;
	for (const account of accounts) {
		const micros = exactProviderAccountMicros(account.liabilityMicros);
		if (micros === undefined) return undefined;
		totalMicros += BigInt(micros);
	}
	return totalMicros;
}

function denial(
	requestId: string,
	targetId: string,
	code: string,
	message: string,
	unavailable = true,
): IacTargetAdmissionDecision {
	return create(IacTargetAdmissionDecisionSchema, {
		requestId,
		targetId,
		status: "denied",
		code,
		message,
		budget: {
			evaluation: unavailable ? "unavailable" : "denied",
			reservation: "not-created",
		},
	});
}

function uncertain(
	requestId: string,
	targetId: string,
	code: string,
	reservation: "unknown" | "held" | "uncertain",
	requestDigest = "",
): IacTargetAdmissionDecision {
	return create(IacTargetAdmissionDecisionSchema, {
		requestId,
		targetId,
		status: "uncertain",
		code,
		message:
			"financial commitment must be reconciled before execution or retry",
		requestDigest,
		budget: { evaluation: "unavailable", reservation },
	});
}

export async function admitIacTarget(
	rawInput: IacTargetAdmissionInput,
	deps: IacTargetAdmissionDeps,
): Promise<IacTargetAdmissionDecision> {
	const input = captureTargetAdmissionInput(rawInput);
	if (input === undefined)
		return denial(
			"",
			"",
			"REQUEST_INVALID",
			"an inspectable admission request is required",
		);
	const { requestId } = input;
	const targetId = safeTargetId(input.inventory);
	if (!safeName(requestId))
		return denial(
			"",
			targetId,
			"REQUEST_INVALID",
			"a bounded request id is required",
		);
	if (
		!isBoundedPricingInput(input.inventory) ||
		!isBoundedPricingInput(input.pricing)
	)
		return denial(
			requestId,
			targetId,
			"PRICING_INPUT_TOO_LARGE",
			"financial input exceeds the bounded data limits",
		);
	if (!isExactProtoMessage(TargetPricingInventorySchema, input.inventory))
		return denial(
			requestId,
			targetId,
			"TARGET_INVENTORY_INCOMPLETE",
			"target inventory contains unsupported or malformed data",
		);
	if (
		input.evidence !== undefined &&
		(!isExactProtoMessage(IacTargetLiabilityEvidenceSchema, input.evidence) ||
			input.evidence.providerAccounts.length > 256)
	)
		return denial(
			requestId,
			targetId,
			"LIABILITY_EVIDENCE_INVALID",
			"liability evidence is malformed or exceeds the bounded data limits",
		);
	if (!isExactProtoMessage(TargetPricingAvailabilitySchema, input.pricing))
		return denial(
			requestId,
			targetId,
			"PRICING_MODEL_INVALID",
			"pricing model contains unsupported or malformed data",
		);
	let inventory: TargetPricingInventory;
	let pricing: TargetPricingAvailability;
	let evidence: IacTargetLiabilityEvidence | undefined;
	let priced: ReturnType<typeof quoteTargetPricing>;
	try {
		inventory = clone(TargetPricingInventorySchema, input.inventory);
		pricing = clone(TargetPricingAvailabilitySchema, input.pricing);
		evidence =
			input.evidence === undefined
				? undefined
				: clone(IacTargetLiabilityEvidenceSchema, input.evidence);
		priced = quoteTargetPricing(inventory, pricing);
	} catch {
		return denial(
			requestId,
			targetId,
			"PRICING_MODEL_INVALID",
			"financial input is malformed",
		);
	}
	if (!priced.ok)
		return denial(requestId, targetId, priced.code, priced.reason);
	if (
		pricing.state.case !== "model" ||
		pricing.state.value.scenario === undefined
	)
		return denial(
			requestId,
			targetId,
			"PRICING_MODEL_INVALID",
			"priced scenario is missing",
		);
	const scenario = pricing.state.value.scenario;
	if (deps.authority.persistence !== "durable-cas")
		return denial(
			requestId,
			targetId,
			"BUDGET_AUTHORITY_UNAVAILABLE",
			"a durable shared budget authority is required",
		);
	let now: string;
	try {
		now = deps.now();
	} catch {
		return denial(
			requestId,
			targetId,
			"TIME_UNAVAILABLE",
			"a current trusted clock is required",
		);
	}
	const nowMs = Date.parse(now);
	const at = Date.parse(scenario.at);
	const horizon = Date.parse(scenario.horizon);
	const total = priced.quote.incremental?.billed;
	const decimal = total === undefined ? undefined : readDecimal(total.decimal);
	const totalMicros = decimal === undefined ? undefined : ceilUnits(decimal, 6);
	if (
		!Number.isFinite(nowMs) ||
		!Number.isFinite(at) ||
		!Number.isFinite(horizon) ||
		at > nowMs ||
		horizon <= nowMs ||
		total?.currency !== "USD" ||
		totalMicros === undefined
	)
		return denial(
			requestId,
			targetId,
			"PRICING_NOT_COMPARABLE",
			"a current nonnegative USD quote is required",
		);
	const maximumMicros =
		evidence === undefined ? undefined : exactEvidenceMaximumMicros(evidence);
	if (
		evidence === undefined ||
		!safeName(evidence.evidenceRef) ||
		evidence.targetId !== targetId ||
		evidence.tenantId !== inventory.tenantId ||
		evidence.planDigest !== inventory.planDigest ||
		evidence.inventoryHash !== priced.inventoryHash ||
		evidence.modelHash !== priced.modelHash ||
		evidence.quoteHash !== priced.quote.quoteHash ||
		maximumMicros === undefined ||
		maximumMicros < totalMicros ||
		!Number.isFinite(Date.parse(evidence.observedAt)) ||
		Date.parse(evidence.observedAt) > nowMs ||
		!Number.isFinite(Date.parse(evidence.validUntil)) ||
		Date.parse(evidence.validUntil) <= nowMs
	)
		return denial(
			requestId,
			targetId,
			"LIABILITY_EVIDENCE_INVALID",
			"current liability evidence must cover this exact target, model and quote",
		);
	const expectedAccounts = [
		...new Set(
			inventory.resources.map((resource) => resource.providerAccountRef),
		),
	].sort(compareIdentifier);
	const accounts = [...evidence.providerAccounts].sort((left, right) =>
		compareIdentifier(left.providerAccountId, right.providerAccountId),
	);
	if (
		accounts.length !== expectedAccounts.length ||
		accounts.some(
			(account, index) => account.providerAccountId !== expectedAccounts[index],
		) ||
		totalProviderAccountMicros(accounts) !== BigInt(maximumMicros)
	)
		return denial(
			requestId,
			targetId,
			"LIABILITY_EVIDENCE_INVALID",
			"liability evidence must cover every target account exactly once",
		);
	try {
		if (
			(await deps.verifyLiability({
				evidence: clone(IacTargetLiabilityEvidenceSchema, evidence),
				inventory: clone(TargetPricingInventorySchema, inventory),
				scenario: clone(QuoteScenarioSchema, scenario),
				quote: clone(QuoteVectorSchema, priced.quote),
			})) !== true
		)
			return denial(
				requestId,
				targetId,
				"LIABILITY_EVIDENCE_UNVERIFIED",
				"liability evidence was not authenticated",
			);
	} catch {
		return denial(
			requestId,
			targetId,
			"LIABILITY_VERIFIER_UNAVAILABLE",
			"liability evidence verification failed",
		);
	}
	const baseline = clone(QuoteScenarioSchema, scenario);
	baseline.candidate = [];
	const baselineQuote = quoteScenarioV2(baseline);
	if (!isQuoteVector(baselineQuote))
		return denial(
			requestId,
			targetId,
			baselineQuote.code,
			baselineQuote.message,
		);
	const claims = incrementalEntitlementClaims(
		priced.quote.consumption,
		baselineQuote.consumption,
		"USD",
	);
	if (claims === undefined)
		return denial(
			requestId,
			targetId,
			"ENTITLEMENT_CONSUMPTION_INVALID",
			"pricing consumption cannot be reserved safely",
		);
	if (
		JSON.stringify(entitlementRows(evidence.entitlementClaims)) !==
		JSON.stringify(entitlementRows(claims))
	)
		return denial(
			requestId,
			targetId,
			"LIABILITY_EVIDENCE_INVALID",
			"liability evidence must itemize the exact incremental entitlement claims",
		);
	const evidenceHash = stableHash(
		toJson(IacTargetLiabilityEvidenceSchema, evidence, {
			alwaysEmitImplicit: true,
		}),
	);
	const financialPlanHash = stableHash({
		planDigest: inventory.planDigest,
		inventoryHash: priced.inventoryHash,
		modelHash: priced.modelHash,
		quoteHash: priced.quote.quoteHash,
		evidenceHash,
	});
	const requestDigest = stableHash({
		requestId,
		targetId,
		tenantId: inventory.tenantId,
		financialPlanHash,
	});
	const providers = [
		...new Set(inventory.resources.map((resource) => resource.providerId)),
	];
	const firstProvider = providers[0];
	if (firstProvider === undefined)
		return denial(
			requestId,
			targetId,
			"TARGET_INVENTORY_INCOMPLETE",
			"target has no provider",
		);
	const validUntil =
		Date.parse(evidence.validUntil) < horizon
			? evidence.validUntil
			: scenario.horizon;
	const quote = create(HostingQuoteSchema, {
		quoteId: financialPlanHash,
		yardId: targetId,
		providerId: providers.length === 1 ? firstProvider : "multi-provider",
		ownerTenantId: inventory.tenantId,
		currency: "USD",
		totalMicros,
		liabilityBoundMicros: maximumMicros,
		observedAt: evidence.observedAt,
		validUntil,
		components: [{ name: "joint-target-quote", costMicros: totalMicros }],
		requestDigest,
		providerAccounts: accounts,
		entitlementClaims: claims,
		financialPlanHash,
	});
	let ledger: ReturnType<BudgetAdmissionAuthority["read"]>;
	try {
		validateHostingQuote(quote, deps.now());
		ledger = await deps.authority.read(deps.now());
	} catch {
		return denial(
			requestId,
			targetId,
			"BUDGET_AUTHORITY_UNAVAILABLE",
			"budget or quote evidence is unavailable",
		);
	}
	const ledgerIdentity = ledger.identity;
	if (
		ledgerIdentity === undefined ||
		!isExactProtoMessage(BudgetIdentitySchema, ledgerIdentity) ||
		ledgerIdentity.tenantId !== inventory.tenantId
	)
		return denial(
			requestId,
			targetId,
			"BUDGET_SCOPE_MISMATCH",
			"the budget does not belong to the target tenant",
		);
	const identity = cloneIdentity(ledgerIdentity);
	let policy: { gate: GateDecision; proof: HostingPolicyProof };
	try {
		policy = await deps.authorize({
			requestDigest,
			quote: clone(HostingQuoteSchema, quote),
			identity: cloneIdentity(identity),
		});
	} catch {
		return denial(
			requestId,
			targetId,
			"POLICY_UNAVAILABLE",
			"budget policy authorization failed",
		);
	}
	let proof: HostingPolicyProof;
	try {
		if (!policy || !isBoundedPricingInput(policy))
			throw new Error("malformed policy decision");
		policy = structuredClone(policy);
		if (
			Object.keys(policy).length !== 2 ||
			!validIacPolicyGate(policy.gate) ||
			!isExactProtoMessage(HostingPolicyProofSchema, policy.proof)
		)
			throw new Error("malformed policy decision");
		proof = clone(HostingPolicyProofSchema, policy.proof);
	} catch {
		return denial(
			requestId,
			targetId,
			"POLICY_UNAVAILABLE",
			"budget policy proof is malformed",
		);
	}
	if (
		(policy.gate?.effect !== "allow" &&
			policy.gate.effect !== "allow-degraded") ||
		proof.effect !== policy.gate.effect ||
		proof.obligationsSatisfied !== true ||
		!proof.policyHash ||
		!proof.evidenceRef ||
		proof.requestDigest !== requestDigest ||
		proof.quoteId !== quote.quoteId ||
		proof.identity === undefined ||
		budgetIdentityKey(proof.identity) !== budgetIdentityKey(identity)
	)
		return denial(
			requestId,
			targetId,
			"POLICY_NOT_ALLOWED",
			"policy denied, requires approval or has unfulfilled obligations",
			false,
		);
	const reservationId = `iac:${requestId}`;
	const pricingPin = create(IacPricingPinSchema, {
		planDigest: inventory.planDigest,
		inventoryHash: priced.inventoryHash,
		modelHash: priced.modelHash,
		quoteHash: priced.quote.quoteHash,
		evidenceHash,
		validUntil: quote.validUntil,
	});
	const quoteDigest = createHash("sha256")
		.update(toJsonString(HostingQuoteSchema, quote))
		.digest("hex");
	let legacyQuoteDigest: string | undefined;
	if (
		quote.entitlementClaims.every(
			(claim) => persistedClaimKind(claim.kind) === "allowance",
		)
	) {
		const legacyQuote = clone(HostingQuoteSchema, quote);
		for (const claim of legacyQuote.entitlementClaims) claim.kind = "";
		legacyQuoteDigest = createHash("sha256")
			.update(toJsonString(HostingQuoteSchema, legacyQuote))
			.digest("hex");
	}
	const captureReceipt = (
		raw: BudgetReservation,
	): BudgetReservation | undefined => {
		try {
			if (!isExactProtoMessage(BudgetReservationSchema, raw)) return undefined;
			const row = clone(BudgetReservationSchema, raw);
			if (
				row.reservationId !== reservationId ||
				row.requestDigest !== requestDigest ||
				row.quoteId !== quote.quoteId ||
				(row.quoteDigest !== quoteDigest &&
					row.quoteDigest !== legacyQuoteDigest) ||
				row.financialPlanHash !== financialPlanHash ||
				row.identity === undefined ||
				budgetIdentityKey(row.identity) !== budgetIdentityKey(identity) ||
				row.reservedMicros !== quote.liabilityBoundMicros ||
				row.actualMicros !== 0 ||
				row.unboundedExposure ||
				row.unpricedPolicyProof !== undefined ||
				row.unpricedScopeProof !== undefined ||
				row.iacPricingPin === undefined ||
				toJsonString(IacPricingPinSchema, row.iacPricingPin) !==
					toJsonString(IacPricingPinSchema, pricingPin) ||
				JSON.stringify(accountRows(row.providerAccounts)) !==
					JSON.stringify(accountRows(quote.providerAccounts)) ||
				JSON.stringify(entitlementRows(row.entitlementClaims)) !==
					JSON.stringify(entitlementRows(quote.entitlementClaims))
			)
				return undefined;
			return row;
		} catch {
			return undefined;
		}
	};
	let reservation: ReturnType<BudgetAdmissionAuthority["reserve"]>;
	try {
		validateHostingQuote(quote, deps.now());
		ledger = await deps.authority.read(deps.now());
		if (
			ledger.identity === undefined ||
			budgetIdentityKey(ledger.identity) !== budgetIdentityKey(identity)
		)
			return denial(
				requestId,
				targetId,
				"BUDGET_POLICY_CHANGED",
				"budget identity changed during authorization",
			);
		reservation = await deps.authority.reserve({
			reservationId,
			requestDigest,
			quote: clone(HostingQuoteSchema, quote),
			iacPricingPin: clone(IacPricingPinSchema, pricingPin),
			identity: cloneIdentity(identity),
			expectedSeq: ledger.seq,
			now: deps.now(),
		});
	} catch (error) {
		if (error instanceof BudgetAdmissionDeniedError)
			return denial(
				requestId,
				targetId,
				error.code,
				error.message,
				error.code === "budget.settlement-unavailable",
			);

		return uncertain(
			requestId,
			targetId,
			"RESERVATION_OUTCOME_UNKNOWN",
			"unknown",
			requestDigest,
		);
	}
	const capturedReservation = captureReceipt(reservation);
	if (capturedReservation === undefined)
		return uncertain(
			requestId,
			targetId,
			"PRICED_RESERVATION_RECEIPT_INVALID",
			"unknown",
			requestDigest,
		);
	reservation = capturedReservation;
	if (reservation.status !== "held")
		return uncertain(
			requestId,
			targetId,
			"RESERVATION_UNCERTAIN",
			"uncertain",
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
			budget: { evaluation: "allowed", reservation: "held" },
			requestDigest,
			reservation,
			quote,
		});
	}
	try {
		validateHostingQuote(quote, deps.now());
		const head = await deps.authority.read(deps.now());
		const claimed = captureReceipt(
			await deps.authority.claimExecution({
				reservationId,
				requestDigest,
				executionDigest,
				expectedSeq: head.seq,
			}),
		);
		if (
			claimed === undefined ||
			claimed.status !== "held" ||
			claimed.executionDigest !== executionDigest
		)
			return uncertain(
				requestId,
				targetId,
				"PRICED_EXECUTION_RECEIPT_INVALID",
				"held",
				requestDigest,
			);
		if (claimed.ledgerSeq !== head.seq + 1)
			return create(IacTargetAdmissionDecisionSchema, {
				requestId,
				targetId,
				status: "replay",
				code: "EXECUTION_ALREADY_CLAIMED",
				budget: { evaluation: "allowed", reservation: "held" },
				requestDigest,
				reservation: claimed,
				quote,
			});
		reservation = claimed;
		validateHostingQuote(quote, deps.now());
		const stillHeld = await deps.authority.revalidatePriced({
			reservationId,
			requestId,
			targetId,
			tenantId: inventory.tenantId,
			requestDigest,
			planDigest: inventory.planDigest,
			inventoryHash: priced.inventoryHash,
			modelHash: priced.modelHash,
			quoteHash: priced.quote.quoteHash,
			now: deps.now(),
		});
		if (stillHeld !== true)
			return uncertain(
				requestId,
				targetId,
				"PRICED_EXECUTION_UNVERIFIED",
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
		budget: { evaluation: "allowed", reservation: "held" },
		requestDigest,
		inventoryHash: priced.inventoryHash,
		modelHash: priced.modelHash,
		quoteHash: priced.quote.quoteHash,
		quote,
		reservation,
		policyProof: proof,
	});
}

function cloneIdentity(identity: BudgetIdentity): BudgetIdentity {
	return clone(BudgetIdentitySchema, identity);
}
