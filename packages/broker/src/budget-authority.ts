import { createHash } from "node:crypto";
import { types } from "node:util";
import { clone, create, toJson, toJsonString } from "@bufbuild/protobuf";
import { budgetScopeIdentityKey } from "@hobo/core";
import { stableHash } from "@hobo/pricing";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	BudgetFenceSettlementGuardSchema,
	type BudgetIdentity,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	type BudgetReservation,
	BudgetReservationSchema,
	BudgetSettlementEvidenceSchema,
	type BudgetSettlementEvidence as GeneratedSettlementEvidence,
	type HostingQuote,
	HostingQuoteSchema,
	type IacPricingPin,
	type IacUnpricedPolicyProof,
	IacUnpricedPolicyProofSchema,
	type IacUnpricedScopeProof,
	IacUnpricedScopeProofSchema,
} from "./_generated/yard_placement_pb.js";
import {
	type BudgetFenceGuardRequest,
	type BudgetFenceTrust,
	createBudgetFenceVerifier,
} from "./budget-fence-settlement.js";

export type {
	BudgetEntitlement,
	BudgetProviderAccount,
	EntitlementClaim,
	HostingPolicyProof,
	ProviderAccountExposure,
} from "./_generated/yard_placement_pb.js";
export {
	BudgetAuthorityEventSchema,
	BudgetEntitlementSchema,
	BudgetIdentitySchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	BudgetReservationSchema,
	BudgetSettlementEvidenceSchema,
	EntitlementClaimSchema,
	HostingPolicyProofSchema,
	HostingQuoteComponentSchema,
	HostingQuoteSchema,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
	ProviderAccountExposureSchema,
} from "./_generated/yard_placement_pb.js";
export type {
	BudgetAuthorityEvent,
	BudgetIdentity,
	BudgetLedgerSnapshot,
	BudgetReservation,
	HostingQuote,
	IacUnpricedPolicyProof,
	IacUnpricedScopeProof,
};
export type BudgetSettlementEvidence = Pick<
	GeneratedSettlementEvidence,
	"usageEvidenceRef" | "sourceStoppedEvidenceRef"
> &
	Partial<
		Pick<
			GeneratedSettlementEvidence,
			| "providerAccounts"
			| "entitlementClaims"
			| "fenceOperationReceiptJson"
			| "financeSignature"
		>
	>;

export type BudgetAdmissionDeniedCode =
	| "budget.exhausted"
	| "budget.unbounded-exposure"
	| "budget.bounded-exposure"
	| "budget.exposure-limit"
	| "budget.scope-unverified"
	| "budget.settlement-unavailable"
	| "provider.exhausted"
	| "entitlement.exhausted"
	| "policy.denied";

/** Definitive allowance refusal before any admission write. Transport, replay,
 * identity, invalid evidence and persistence failures must retain their errors. */
export class BudgetAdmissionDeniedError extends Error {
	readonly code: BudgetAdmissionDeniedCode;

	constructor(code: BudgetAdmissionDeniedCode, message: string) {
		super(message);
		this.name = "BudgetAdmissionDeniedError";
		this.code = code;
	}
}

export function budgetIdentityKey(identity: BudgetIdentity): string {
	return budgetScopeIdentityKey(identity);
}

export function budgetMicros(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError("cost must be nonnegative integer USD microdollars");
	return value;
}

function add(...values: number[]): number {
	return budgetMicros(
		values.reduce((sum, value) => sum + budgetMicros(value), 0),
	);
}

function boundedName(value: string, limit = 200): boolean {
	return (
		value.length > 0 &&
		value.length <= limit &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function validEntitlementKind(kind: string): boolean {
	return ["allowance", "credit", "commitment"].includes(kind);
}

type EntitlementScope = { kind: string; bucketId: string; unit: string };

function entitlementScopeKey(row: EntitlementScope): string {
	return JSON.stringify([row.kind, row.bucketId, row.unit]);
}

function sameEntitlementScope(
	left: EntitlementScope,
	right: EntitlementScope,
): boolean {
	return (
		left.kind === right.kind &&
		left.bucketId === right.bucketId &&
		left.unit === right.unit
	);
}

function unboundedFingerprint(input: {
	requestDigest: string;
	inventoryHash: string;
	policyProof: IacUnpricedPolicyProof;
	scopeProof: IacUnpricedScopeProof;
	identity: BudgetIdentity;
	providerAccountIds: readonly string[];
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				requestDigest: input.requestDigest,
				inventoryHash: input.inventoryHash,
				policyProof: toJsonString(
					IacUnpricedPolicyProofSchema,
					input.policyProof,
				),
				scopeProof: toJsonString(IacUnpricedScopeProofSchema, input.scopeProof),
				identity: input.identity,
				providerAccountIds: [...input.providerAccountIds].sort(),
			}),
		)
		.digest("hex");
}

export interface IacUnpricedScopeTrust {
	verify(proof: IacUnpricedScopeProof): boolean;
	isCurrent(proof: IacUnpricedScopeProof): boolean;
	settlement(input: {
		reservation: BudgetReservation;
		actualMicros: number;
		evidence: GeneratedSettlementEvidence;
	}): boolean;
}

export interface IacPricedSettlementTrust {
	verify(input: {
		reservation: BudgetReservation;
		actualMicros: number;
		evidence: GeneratedSettlementEvidence;
	}): boolean;
}

const applyTrust = Reflect.apply;
const trustGetPrototype = Object.getPrototypeOf;
const trustGetDescriptor = Object.getOwnPropertyDescriptor;
const trustHasOwn = Object.hasOwn;
const isProxyTrust = types.isProxy;
const isNativePromise = types.isPromise;
const nativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const nativePromiseThen = Promise.prototype.then;
const initialPromiseSpecies = trustGetDescriptor(Promise, Symbol.species);
const nativePromiseSpecies =
	initialPromiseSpecies !== undefined &&
	trustHasOwn(initialPromiseSpecies, "get")
		? initialPromiseSpecies.get
		: undefined;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: host verifier results and callable ports cross a runtime authority boundary. */
function synchronousVerdict(value: unknown): boolean {
	if (value === true) return true;
	try {
		if (isProxyTrust(value) || !isNativePromise(value)) return false;
		const constructorField = trustGetDescriptor(
			nativePromisePrototype,
			"constructor",
		);
		const species = trustGetDescriptor(nativePromise, Symbol.species);
		if (
			trustGetPrototype(value) === nativePromisePrototype &&
			trustGetDescriptor(value, "constructor") === undefined &&
			constructorField !== undefined &&
			trustHasOwn(constructorField, "value") &&
			constructorField.value === nativePromise &&
			nativePromiseSpecies !== undefined &&
			species !== undefined &&
			trustHasOwn(species, "get") &&
			species.get === nativePromiseSpecies
		)
			void applyTrust(nativePromiseThen, value, [() => {}, () => {}]);
	} catch {
		return false;
	}
	return false;
}

function trustCallback<T extends object, Key extends keyof T>(
	trust: T,
	key: Key,
): T[Key] {
	if (
		typeof trust !== "object" ||
		trust === null ||
		isProxyTrust(trust) ||
		Array.isArray(trust)
	)
		throw new TypeError("invalid financial trust authority");
	const field = trustGetDescriptor(trust, key);
	if (
		field === undefined ||
		!trustHasOwn(field, "value") ||
		!field.enumerable ||
		typeof field.value !== "function" ||
		isProxyTrust(field.value)
	)
		throw new TypeError("financial trust callbacks must be own data functions");
	return field.value;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

export function captureIacPricedSettlementTrust(
	trust: IacPricedSettlementTrust | undefined,
): IacPricedSettlementTrust | undefined {
	if (trust === undefined) return undefined;
	const verify = trustCallback(trust, "verify");
	const captured: IacPricedSettlementTrust = {
		verify: (input) =>
			synchronousVerdict(applyTrust(verify, captured, [input])),
	};
	return Object.freeze(captured);
}

export function captureIacUnpricedScopeTrust(
	trust: IacUnpricedScopeTrust | undefined,
): IacUnpricedScopeTrust | undefined {
	if (trust === undefined) return undefined;
	const verify = trustCallback(trust, "verify");
	const isCurrent = trustCallback(trust, "isCurrent");
	const settlement = trustCallback(trust, "settlement");
	const captured: IacUnpricedScopeTrust = {
		verify: (proof) =>
			synchronousVerdict(applyTrust(verify, captured, [proof])),
		isCurrent: (proof) =>
			synchronousVerdict(applyTrust(isCurrent, captured, [proof])),
		settlement: (input) =>
			synchronousVerdict(applyTrust(settlement, captured, [input])),
	};
	return Object.freeze(captured);
}

function validScopeProof(
	proof: IacUnpricedScopeProof,
	identity: BudgetIdentity,
	ids: readonly string[],
): boolean {
	return (
		proof.identity !== undefined &&
		budgetIdentityKey(proof.identity) === budgetIdentityKey(identity) &&
		proof.exclusiveUntilSettled &&
		proof.noSharedEntitlements &&
		boundedName(proof.authorityRef) &&
		boundedName(proof.evidenceRef) &&
		boundedName(proof.ownershipEpoch) &&
		boundedName(proof.signature, 4096) &&
		Number.isFinite(Date.parse(proof.observedAt)) &&
		proof.providerAccountIds.length > 0 &&
		proof.providerAccountIds.length <= 256 &&
		new Set(proof.providerAccountIds).size ===
			proof.providerAccountIds.length &&
		JSON.stringify([...proof.providerAccountIds].sort()) ===
			JSON.stringify([...ids].sort())
	);
}

function validIacPin(pin: IacPricingPin, financialPlanHash: string): boolean {
	const pattern = /^sha256:[a-f0-9]{64}$/u;
	return (
		[
			pin.planDigest,
			pin.inventoryHash,
			pin.modelHash,
			pin.quoteHash,
			pin.evidenceHash,
		].every((value) => pattern.test(value)) &&
		Number.isFinite(Date.parse(pin.validUntil)) &&
		stableHash({
			planDigest: pin.planDigest,
			inventoryHash: pin.inventoryHash,
			modelHash: pin.modelHash,
			quoteHash: pin.quoteHash,
			evidenceHash: pin.evidenceHash,
		}) === financialPlanHash
	);
}

function validUnpricedProof(
	proof: IacUnpricedPolicyProof,
	identity: BudgetIdentity,
	requestDigest: string,
	inventoryHash: string,
): boolean {
	return (
		proof.requestDigest === requestDigest &&
		proof.inventoryHash === inventoryHash &&
		proof.identity !== undefined &&
		budgetIdentityKey(proof.identity) === budgetIdentityKey(identity) &&
		(proof.effect === "allow" || proof.effect === "allow-degraded") &&
		proof.obligationsSatisfied &&
		Number.isFinite(Date.parse(proof.observedAt)) &&
		Number.isFinite(Date.parse(proof.validUntil)) &&
		Date.parse(proof.observedAt) < Date.parse(proof.validUntil) &&
		boundedName(proof.policyHash) &&
		boundedName(proof.evidenceRef)
	);
}

export function validateBudgetSnapshot(
	snapshot: BudgetLedgerSnapshot,
	now: string,
): void {
	if (!snapshot.identity) throw new TypeError("budget identity missing");
	budgetIdentityKey(snapshot.identity);
	for (const value of [
		snapshot.limitMicros,
		snapshot.spentMicros,
		snapshot.reservedMicros,
		snapshot.unresolvedMicros,
		snapshot.recoveryReserveMicros,
		snapshot.externalCommittedMicros,
	])
		budgetMicros(value);
	if (
		new Set(snapshot.providerAccounts.map((row) => row.providerAccountId))
			.size !== snapshot.providerAccounts.length ||
		new Set(snapshot.entitlements.map(entitlementScopeKey)).size !==
			snapshot.entitlements.length
	)
		throw new TypeError("duplicate financial scope");
	for (const row of snapshot.providerAccounts) {
		if (!row.providerAccountId)
			throw new TypeError("provider account identity required");
		for (const value of [
			row.limitMicros,
			row.spentMicros,
			row.reservedMicros,
			row.externalCommittedMicros,
		])
			budgetMicros(value);
	}
	for (const row of snapshot.entitlements) {
		if (
			!validEntitlementKind(row.kind) ||
			!row.bucketId ||
			!row.unit ||
			!row.periodId ||
			!Number.isFinite(Date.parse(row.observedAt)) ||
			!Number.isFinite(Date.parse(row.validUntil))
		)
			throw new TypeError("entitlement scope and evidence required");
		budgetMicros(row.remainingUnits);
		budgetMicros(row.reservedUnits);
	}
	if (
		!Number.isSafeInteger(snapshot.seq) ||
		snapshot.seq < 0 ||
		snapshot.seq >= 4294967295
	)
		throw new TypeError("invalid budget sequence");
	if (snapshot.unboundedExposureCount > 256)
		throw new TypeError("too many unbounded exposures");
	if (
		!Number.isFinite(Date.parse(now)) ||
		!Number.isFinite(Date.parse(snapshot.observedAt)) ||
		!Number.isFinite(Date.parse(snapshot.validUntil)) ||
		Date.parse(snapshot.observedAt) > Date.parse(now) ||
		Date.parse(snapshot.validUntil) <= Date.parse(now)
	)
		throw new TypeError("budget snapshot is stale or future-dated");
}

export function validateHostingQuote(quote: HostingQuote, now: string): void {
	if (
		!quote.quoteId ||
		!quote.yardId ||
		!quote.providerId ||
		!quote.ownerTenantId ||
		!quote.requestDigest ||
		quote.currency !== "USD"
	)
		throw new TypeError("complete USD hosting quote required");
	budgetMicros(quote.totalMicros);
	if (
		quote.liabilityBoundMicros === undefined ||
		budgetMicros(quote.liabilityBoundMicros) < quote.totalMicros
	)
		throw new TypeError(
			"hosting admission requires a conservative liability bound, not only an estimate",
		);
	if (
		!quote.components.length ||
		quote.components.some((component) => !component.name) ||
		add(...quote.components.map((component) => component.costMicros)) !==
			quote.totalMicros
	)
		throw new TypeError("hosting quote must itemize its complete total");
	if (
		new Set(quote.providerAccounts.map((row) => row.providerAccountId)).size !==
			quote.providerAccounts.length ||
		new Set(quote.entitlementClaims.map(entitlementScopeKey)).size !==
			quote.entitlementClaims.length
	)
		throw new TypeError("duplicate quote financial scope");
	if (
		quote.providerAccounts.length &&
		(quote.providerAccounts.some((row) => !row.providerAccountId) ||
			add(...quote.providerAccounts.map((row) => row.liabilityMicros)) !==
				quote.liabilityBoundMicros)
	)
		throw new TypeError(
			"provider-account exposures must itemize the liability bound",
		);
	for (const row of quote.entitlementClaims) {
		if (!validEntitlementKind(row.kind))
			throw new TypeError("unsupported entitlement kind");
		if (!row.bucketId || !row.unit)
			throw new TypeError("entitlement scope missing");
		budgetMicros(row.units);
	}
	if (
		!Number.isFinite(Date.parse(now)) ||
		!Number.isFinite(Date.parse(quote.observedAt)) ||
		!Number.isFinite(Date.parse(quote.validUntil)) ||
		Date.parse(quote.observedAt) > Date.parse(now) ||
		Date.parse(quote.validUntil) <= Date.parse(now)
	)
		throw new TypeError("hosting quote is stale or future-dated");
}

/** The host supplies ONE authoritative transactional implementation per budget.
 * Reserve must recheck identity, current exposure and sequence atomically.
 * An uncertain external effect must retain its reservation until reconciled. */
export interface BudgetAdmissionAuthority {
	readonly persistence: "memory" | "durable-cas";
	read(now: string): BudgetLedgerSnapshot;
	lookup(reservationId: string): BudgetReservation | undefined;
	claimExecution(input: {
		reservationId: string;
		requestDigest: string;
		executionDigest: string;
		/** Head used to revalidate policy and exposure immediately before execution. */
		expectedSeq?: number;

		now?: string;
	}): BudgetReservation;
	reserve(input: {
		reservationId: string;
		requestDigest: string;
		quote: HostingQuote;
		identity: BudgetIdentity;
		/** Installed and authenticated at initial admission; never added later. */
		fenceSettlementGuard?: BudgetFenceGuardRequest;
		iacPricingPin?: IacPricingPin;
		expectedSeq: number;
		now: string;
	}): BudgetReservation;

	reserveUnbounded(input: {
		reservationId: string;
		requestDigest: string;
		inventoryHash: string;
		policyProof: IacUnpricedPolicyProof;
		scopeProof: IacUnpricedScopeProof;
		identity: BudgetIdentity;
		providerAccountIds: readonly string[];
		expectedSeq: number;
		now: string;
	}): BudgetReservation;
	revalidateUnbounded(input: {
		reservationId: string;
		requestDigest: string;
		inventoryHash: string;
		executionDigest: string;
		policyProofHash: string;
		scopeProofHash: string;
		now: string;
	}): boolean;
	revalidatePriced(input: {
		reservationId: string;
		requestId: string;
		targetId: string;
		tenantId: string;
		requestDigest: string;
		planDigest: string;
		inventoryHash: string;
		modelHash: string;
		quoteHash: string;
		now: string;
	}): boolean;
	settle(
		reservationId: string,
		actualMicros: number,
		evidence: BudgetSettlementEvidence,
	): BudgetReservation;
	uncertain(reservationId: string): BudgetReservation;
	/** Only a reservation never claimed for execution can be released as unused.
	 * Claimed work requires final usage settlement, including verified zero usage. */
	release(
		reservationId: string,
		confirmedUnused: true,
		evidenceRef: string,
	): BudgetReservation;
}

/** Single-writer authority. Persist every event with a synchronous durable CAS
 * in `commit` before acknowledgement, or use this explicitly as an in-memory
 * authority. Reopen by supplying its recorded events. No network I/O in commit.
 * Independent process writers require a shared transactional port adapter. */
export function createBudgetAdmissionAuthority(options: {
	snapshot: BudgetLedgerSnapshot;
	priorEvents?: readonly BudgetAuthorityEvent[];
	/** Independently enrolled receiver and financial signing authorities. */
	fenceTrust?: BudgetFenceTrust;
	unpricedScopeTrust?: IacUnpricedScopeTrust;
	iacPricedSettlementTrust?: IacPricedSettlementTrust;
	commit?: (event: BudgetAuthorityEvent, expectedSeq: number) => void;
}): BudgetAdmissionAuthority & {
	configure(
		snapshot: BudgetLedgerSnapshot,
		expectedSeq: number,
		now: string,
		evidence?: { liabilityResolutionEvidenceRef?: string },
	): void;
} {
	let current = clone(BudgetLedgerSnapshotSchema, options.snapshot);
	let reservations = new Map<string, BudgetReservation>();
	const fenced = createBudgetFenceVerifier(options.fenceTrust);
	const scopeTrust = captureIacUnpricedScopeTrust(options.unpricedScopeTrust);
	const pricedSettlementTrust = captureIacPricedSettlementTrust(
		options.iacPricedSettlementTrust,
	);
	validateBudgetSnapshot(current, current.observedAt);
	const replayed = new Map<number, string>();
	const policyFingerprint = (snapshot: BudgetLedgerSnapshot) =>
		JSON.stringify([
			snapshot.limitMicros,
			snapshot.recoveryReserveMicros,
			[...snapshot.providerAccounts]
				.sort((left, right) =>
					left.providerAccountId.localeCompare(right.providerAccountId),
				)
				.map((row) => [row.providerAccountId, row.limitMicros]),
		]);
	const financialScopes = (snapshot: BudgetLedgerSnapshot) =>
		JSON.stringify({
			accounts: snapshot.providerAccounts
				.map((row) => row.providerAccountId)
				.sort(),
			entitlements: snapshot.entitlements
				.map((row) =>
					[row.kind, row.bucketId, row.unit, row.periodId].join("\u0000"),
				)
				.sort(),
		});
	const policyBindings = new Map<string, string>();
	// Derived from the complete journal, including snapshots that no longer expose
	// a bucket. Dropping a projection row must never erase its financial history.
	const retiredPeriods = new Set<string>();
	const entitlementHistory = new Map<
		string,
		Pick<
			BudgetLedgerSnapshot["entitlements"][number],
			"unit" | "observedAt" | "validUntil" | "remainingUnits"
		>
	>();
	const entitlementKey = (
		bucket: BudgetLedgerSnapshot["entitlements"][number],
	) => JSON.stringify([bucket.periodId, bucket.kind, bucket.bucketId]);
	function assertFinancialHistory(
		next: BudgetLedgerSnapshot,
		type: string,
	): void {
		if (
			next.identity &&
			next.identity.periodId !== current.identity?.periodId &&
			retiredPeriods.has(next.identity.periodId)
		)
			throw new Error("retired period cannot be reopened");
		const configuration =
			type === "budget.PolicyRevised" || type === "budget.PeriodReset";
		for (const bucket of next.entitlements) {
			const key = entitlementKey(bucket);
			const previous = entitlementHistory.get(key);
			// Settlement legitimately reduces a live bucket at its existing observation.
			// Configuration and any reintroduced bucket must respect the retained fence.
			if (
				!previous ||
				(!configuration &&
					current.entitlements.some((row) => entitlementKey(row) === key))
			)
				continue;
			const observedAt = Date.parse(bucket.observedAt);
			const previousObservedAt = Date.parse(previous.observedAt);
			if (
				observedAt < previousObservedAt ||
				(observedAt === previousObservedAt &&
					(bucket.remainingUnits !== previous.remainingUnits ||
						bucket.unit !== previous.unit ||
						Date.parse(bucket.validUntil) !== Date.parse(previous.validUntil)))
			)
				throw new Error(
					"entitlement observation must advance with changed allocation, unit or expiry",
				);
		}
	}
	function rememberFinancialHistory(next: BudgetLedgerSnapshot): void {
		if (
			current.identity &&
			next.identity?.periodId !== current.identity.periodId
		)
			retiredPeriods.add(current.identity.periodId);
		for (const bucket of next.entitlements)
			entitlementHistory.set(entitlementKey(bucket), {
				unit: bucket.unit,
				observedAt: bucket.observedAt,
				validUntil: bucket.validUntil,
				remainingUnits: bucket.remainingUnits,
			});
	}
	rememberFinancialHistory(current);
	if (current.identity)
		policyBindings.set(
			budgetIdentityKey(current.identity),
			policyFingerprint(current),
		);
	if (
		current.reservedMicros !== 0 ||
		current.unboundedExposureCount !== 0 ||
		current.providerAccounts.some((row) => row.reservedMicros !== 0) ||
		current.entitlements.some((row) => row.reservedUnits !== 0)
	)
		throw new TypeError("reservation history required for held exposure");
	for (const event of options.priorEvents ?? []) {
		if (!event.snapshot?.identity || !current.identity)
			throw new Error("budget journal snapshot identity missing");
		if (
			event.snapshot.identity.tenantId !== current.identity.tenantId ||
			event.snapshot.identity.budgetId !== current.identity.budgetId
		)
			throw new Error("budget journal ownership mismatch");
		const digest = toJsonString(BudgetAuthorityEventSchema, event);
		if (replayed.has(event.snapshot.seq)) {
			if (replayed.get(event.snapshot.seq) !== digest)
				throw new Error("conflicting budget journal duplicate");
			continue;
		}
		if (event.snapshot.seq !== current.seq + 1)
			throw new Error("budget journal sequence gap");
		validateBudgetSnapshot(event.snapshot, event.snapshot.observedAt);
		const policyKey = budgetIdentityKey(event.snapshot.identity);
		if (
			policyBindings.has(policyKey) &&
			policyBindings.get(policyKey) !== policyFingerprint(event.snapshot)
		)
			throw new Error(
				"journal policy revision reused for different financial limits",
			);
		if (
			new Set(event.reservations.map((row) => row.reservationId)).size !==
			event.reservations.length
		)
			throw new Error("duplicate journal reservation identity");
		if (
			event.snapshot.identity.periodId !== current.identity.periodId &&
			active().length !== 0
		)
			throw new Error("journal period reset discards outstanding commitments");
		if (
			unboundedCount() > 0 &&
			financialScopes(event.snapshot) !== financialScopes(current)
		)
			throw new Error(
				"journal changed financial scopes with unbounded exposure",
			);
		for (const old of reservations.values()) {
			if (old.iacPricingPin) {
				const next = event.reservations.find(
					(row) => row.reservationId === old.reservationId,
				);
				if (!next) {
					if (
						event.snapshot.identity.periodId === current.identity.periodId ||
						old.status === "held" ||
						old.status === "uncertain"
					)
						throw new Error("journal removed a priced IaC reservation");
					continue;
				}
				if (
					JSON.stringify(next.iacPricingPin) !==
						JSON.stringify(old.iacPricingPin) ||
					next.requestDigest !== old.requestDigest ||
					next.quoteId !== old.quoteId ||
					next.quoteDigest !== old.quoteDigest ||
					next.financialPlanHash !== old.financialPlanHash ||
					next.reservedMicros !== old.reservedMicros ||
					JSON.stringify(next.identity) !== JSON.stringify(old.identity) ||
					JSON.stringify(next.providerAccounts) !==
						JSON.stringify(old.providerAccounts) ||
					JSON.stringify(next.entitlementClaims) !==
						JSON.stringify(old.entitlementClaims) ||
					(old.executionDigest &&
						old.executionDigest !== next.executionDigest) ||
					((old.status === "settled" || old.status === "released") &&
						(old.status !== next.status ||
							old.actualMicros !== next.actualMicros ||
							old.usageEvidenceRef !== next.usageEvidenceRef ||
							old.sourceStoppedEvidenceRef !== next.sourceStoppedEvidenceRef ||
							JSON.stringify(old.settlementEvidence) !==
								JSON.stringify(next.settlementEvidence)))
				)
					throw new Error(
						"journal changed an immutable priced IaC reservation",
					);
			}
			if (old.unboundedExposure) {
				const next = event.reservations.find(
					(row) => row.reservationId === old.reservationId,
				);
				if (!next) {
					if (
						event.snapshot.identity.periodId === current.identity.periodId ||
						old.status === "held" ||
						old.status === "uncertain"
					)
						throw new Error("journal removed unbounded exposure");
					continue;
				}
				if (
					!next.unboundedExposure ||
					next.requestDigest !== old.requestDigest ||
					next.quoteId !== old.quoteId ||
					next.quoteDigest !== old.quoteDigest ||
					next.financialPlanHash !== old.financialPlanHash ||
					JSON.stringify(next.unpricedPolicyProof) !==
						JSON.stringify(old.unpricedPolicyProof) ||
					JSON.stringify(next.unpricedScopeProof) !==
						JSON.stringify(old.unpricedScopeProof) ||
					JSON.stringify(next.identity) !== JSON.stringify(old.identity) ||
					JSON.stringify(next.providerAccounts) !==
						JSON.stringify(old.providerAccounts) ||
					JSON.stringify(next.entitlementClaims) !==
						JSON.stringify(old.entitlementClaims) ||
					(old.executionDigest &&
						old.executionDigest !== next.executionDigest) ||
					((old.status === "settled" || old.status === "released") &&
						(old.status !== next.status ||
							old.actualMicros !== next.actualMicros ||
							old.usageEvidenceRef !== next.usageEvidenceRef ||
							old.sourceStoppedEvidenceRef !== next.sourceStoppedEvidenceRef ||
							JSON.stringify(old.settlementEvidence) !==
								JSON.stringify(next.settlementEvidence)))
				)
					throw new Error("journal changed an immutable unbounded reservation");
			}
			if (!old.fenceSettlementGuard) continue;
			const next = event.reservations.find(
				(row) => row.reservationId === old.reservationId,
			);
			if (!next) {
				if (
					event.snapshot.identity.periodId === current.identity.periodId ||
					old.status === "held" ||
					old.status === "uncertain"
				)
					throw new Error("journal removed a fenced reservation");
				continue;
			}
			if (
				!next.fenceSettlementGuard ||
				toJsonString(
					BudgetFenceSettlementGuardSchema,
					old.fenceSettlementGuard,
				) !==
					toJsonString(
						BudgetFenceSettlementGuardSchema,
						next.fenceSettlementGuard,
					) ||
				old.requestDigest !== next.requestDigest ||
				old.quoteId !== next.quoteId ||
				old.quoteDigest !== next.quoteDigest ||
				old.reservedMicros !== next.reservedMicros ||
				old.financialPlanHash !== next.financialPlanHash ||
				JSON.stringify(old.providerAccounts) !==
					JSON.stringify(next.providerAccounts) ||
				JSON.stringify(old.entitlementClaims) !==
					JSON.stringify(next.entitlementClaims) ||
				!old.identity ||
				!next.identity ||
				budgetIdentityKey(old.identity) !== budgetIdentityKey(next.identity) ||
				(old.executionDigest && old.executionDigest !== next.executionDigest) ||
				((old.status === "settled" || old.status === "released") &&
					(old.status !== next.status ||
						old.actualMicros !== next.actualMicros ||
						old.usageEvidenceRef !== next.usageEvidenceRef ||
						old.sourceStoppedEvidenceRef !== next.sourceStoppedEvidenceRef ||
						JSON.stringify(old.settlementEvidence) !==
							JSON.stringify(next.settlementEvidence)))
			)
				throw new Error("journal changed an immutable fenced reservation");
		}
		assertFinancialHistory(event.snapshot, event.type);
		if (
			event.snapshot.identity.periodId === current.identity.periodId &&
			event.snapshot.spentMicros < current.spentMicros
		)
			throw new Error("journal spend watermark regressed");
		if (
			(event.snapshot.unresolvedMicros < current.unresolvedMicros ||
				event.snapshot.externalCommittedMicros <
					current.externalCommittedMicros) &&
			!event.reconciliationEvidenceRef
		)
			throw new Error("journal liability reduction lacks evidence");
		for (const row of event.reservations) {
			if (
				!row.identity ||
				!row.reservationId ||
				!row.requestDigest ||
				!row.quoteDigest ||
				!["held", "uncertain", "settled", "released"].includes(row.status) ||
				row.ledgerSeq > event.snapshot.seq ||
				row.identity.tenantId !== current.identity.tenantId ||
				row.identity.budgetId !== current.identity.budgetId
			)
				throw new Error("invalid journal reservation scope");
			budgetIdentityKey(row.identity);
			budgetMicros(row.reservedMicros);
			budgetMicros(row.actualMicros);
			const old = reservations.get(row.reservationId);
			if (
				row.iacPricingPin &&
				(row.unboundedExposure ||
					(row.status === "released" && !!row.executionDigest) ||
					!validIacPin(row.iacPricingPin, row.financialPlanHash) ||
					(!old &&
						(event.type !== "budget.ReservationHeld" ||
							row.status !== "held" ||
							row.executionDigest)) ||
					(old !== undefined && !old.iacPricingPin))
			)
				throw new Error("invalid priced IaC reservation history");
			if (
				row.unboundedExposure &&
				(row.reservedMicros !== 0 ||
					row.fenceSettlementGuard !== undefined ||
					row.quoteId !== "" ||
					row.unpricedPolicyProof === undefined ||
					row.unpricedScopeProof === undefined ||
					!validScopeProof(
						row.unpricedScopeProof,
						row.identity,
						row.providerAccounts.map((account) => account.providerAccountId),
					) ||
					scopeTrust?.verify(
						clone(IacUnpricedScopeProofSchema, row.unpricedScopeProof),
					) !== true ||
					!validUnpricedProof(
						row.unpricedPolicyProof,
						row.identity,
						row.requestDigest,
						row.financialPlanHash,
					) ||
					row.quoteDigest !==
						unboundedFingerprint({
							requestDigest: row.requestDigest,
							inventoryHash: row.financialPlanHash,
							policyProof: row.unpricedPolicyProof,
							scopeProof: row.unpricedScopeProof,
							identity: row.identity,
							providerAccountIds: row.providerAccounts.map(
								(account) => account.providerAccountId,
							),
						}) ||
					row.providerAccounts.some(
						(account) => account.liabilityMicros !== 0,
					) ||
					row.entitlementClaims.some((claim) => claim.units !== 0) ||
					(!old &&
						(event.type !== "budget.UnboundedExposureHeld" ||
							row.status !== "held" ||
							row.executionDigest)) ||
					(old !== undefined && !old.unboundedExposure) ||
					(row.status === "settled" &&
						(!row.executionDigest ||
							!row.settlementEvidence ||
							!boundedName(row.settlementEvidence.financeSignature, 4096) ||
							!old ||
							(old.status === "held" || old.status === "uncertain"
								? scopeTrust.settlement({
										reservation: clone(BudgetReservationSchema, old),
										actualMicros: row.actualMicros,
										evidence: clone(
											BudgetSettlementEvidenceSchema,
											row.settlementEvidence,
										),
									}) !== true
								: old.status !== "settled"))) ||
					(row.status === "released" && row.executionDigest))
			)
				throw new Error("invalid unbounded reservation history");
			if (
				row.iacPricingPin &&
				!row.fenceSettlementGuard &&
				row.status === "settled"
			) {
				if (
					!old?.executionDigest ||
					!row.settlementEvidence ||
					!boundedName(row.settlementEvidence.financeSignature, 4096) ||
					(old.status === "held" || old.status === "uncertain"
						? pricedSettlementTrust?.verify({
								reservation: clone(BudgetReservationSchema, old),
								actualMicros: row.actualMicros,
								evidence: clone(
									BudgetSettlementEvidenceSchema,
									row.settlementEvidence,
								),
							}) !== true
						: old.status !== "settled")
				)
					throw new Error("authenticated priced IaC settlement required");
			}
			if (row.fenceSettlementGuard) {
				if (
					(!old &&
						(event.type !== "budget.ReservationHeld" ||
							row.status !== "held" ||
							row.executionDigest)) ||
					(old && !old.fenceSettlementGuard)
				)
					throw new Error("fenced guard must be present at initial admission");
				fenced.validate(row);
				if (row.status === "released" && row.executionDigest)
					throw new Error("journal released a claimed fenced reservation");
				if (row.status === "settled") {
					if (!row.settlementEvidence)
						throw new Error("journal lacks fenced settlement evidence");
					fenced.settle(row, row.actualMicros, row.settlementEvidence);
				}
			}
			if (
				(row.status === "held" || row.status === "uncertain") &&
				row.identity.periodId !== event.snapshot.identity.periodId
			)
				throw new Error("active journal reservation period mismatch");
		}
		const iacSettlements = event.reservations.filter((row) => {
			const old = reservations.get(row.reservationId);
			return (
				(row.unboundedExposure || row.iacPricingPin !== undefined) &&
				row.status === "settled" &&
				old !== undefined &&
				(old.status === "held" || old.status === "uncertain")
			);
		});
		if (
			iacSettlements.length > 1 ||
			(event.type === "budget.UnboundedUsageRecorded" &&
				(iacSettlements.length !== 1 || !iacSettlements[0]?.unboundedExposure))
		)
			throw new Error("invalid IaC settlement transition");
		if (iacSettlements.length === 1) {
			const row = iacSettlements[0];
			if (!row) throw new Error("IaC settlement missing");
			const expectedType = row.unboundedExposure
				? "budget.UnboundedUsageRecorded"
				: row.actualMicros > row.reservedMicros
					? "budget.OverrunRecorded"
					: "budget.ReservationSettled";
			if (event.type !== expectedType)
				throw new Error("invalid IaC settlement event type");
			const old = reservations.get(row.reservationId);
			const evidence = row.settlementEvidence;
			if (
				!old ||
				!evidence ||
				event.reservations.length !== reservations.size ||
				event.reconciliationEvidenceRef
			)
				throw new Error("invalid IaC settlement record");
			for (const entry of event.reservations) {
				const prior = reservations.get(entry.reservationId);
				if (!prior) throw new Error("settlement introduced a reservation");
				if (
					entry.reservationId !== row.reservationId &&
					toJsonString(BudgetReservationSchema, prior) !==
						toJsonString(BudgetReservationSchema, entry)
				)
					throw new Error("settlement changed another reservation");
			}
			const accounts = evidence.providerAccounts;
			const claims = evidence.entitlementClaims;
			if (
				accounts.length !== old.providerAccounts.length ||
				claims.length !== old.entitlementClaims.length ||
				new Set(accounts.map((account) => account.providerAccountId)).size !==
					accounts.length ||
				new Set(claims.map(entitlementScopeKey)).size !== claims.length ||
				(accounts.length > 0 &&
					add(...accounts.map((account) => account.liabilityMicros)) !==
						row.actualMicros)
			)
				throw new Error("invalid IaC settlement dimensions");
			const expected = clone(BudgetLedgerSnapshotSchema, current);
			expected.seq = event.snapshot.seq;
			expected.spentMicros = add(current.spentMicros, row.actualMicros);
			for (const account of accounts) {
				const target = expected.providerAccounts.find(
					(entry) => entry.providerAccountId === account.providerAccountId,
				);
				if (
					!target ||
					!old.providerAccounts.some(
						(entry) => entry.providerAccountId === account.providerAccountId,
					)
				)
					throw new Error("foreign provider settlement");
				target.spentMicros = add(target.spentMicros, account.liabilityMicros);
			}
			for (const claim of claims) {
				const target = expected.entitlements.find((entry) =>
					sameEntitlementScope(entry, claim),
				);
				if (
					!target ||
					!old.entitlementClaims.some((entry) =>
						sameEntitlementScope(entry, claim),
					)
				)
					throw new Error("foreign entitlement settlement");
				target.remainingUnits = Math.max(
					0,
					target.remainingUnits - budgetMicros(claim.units),
				);
			}
			const rows = new Map(
				event.reservations.map((entry) => [entry.reservationId, entry]),
			);
			expected.reservedMicros = held(rows);
			expected.unboundedExposureCount = unboundedCount(rows);
			updateDimensions(expected, rows);
			if (
				toJsonString(BudgetLedgerSnapshotSchema, expected) !==
				toJsonString(BudgetLedgerSnapshotSchema, event.snapshot)
			)
				throw new Error("IaC settlement snapshot does not account for usage");
			const expectedRow = clone(BudgetReservationSchema, old);
			expectedRow.status = "settled";
			expectedRow.ledgerSeq = event.snapshot.seq;
			expectedRow.actualMicros = row.actualMicros;
			expectedRow.usageEvidenceRef = evidence.usageEvidenceRef;
			expectedRow.sourceStoppedEvidenceRef = evidence.sourceStoppedEvidenceRef;
			expectedRow.settlementEvidence = clone(
				BudgetSettlementEvidenceSchema,
				evidence,
			);
			if (
				toJsonString(BudgetReservationSchema, expectedRow) !==
				toJsonString(BudgetReservationSchema, row)
			)
				throw new Error("IaC settlement changed its reservation");
		}
		if (event.snapshot.identity.periodId === current.identity.periodId) {
			for (const old of current.providerAccounts) {
				const account = event.snapshot.providerAccounts.find(
					(row) => row.providerAccountId === old.providerAccountId,
				);
				if (old.spentMicros > (account?.spentMicros ?? 0))
					throw new Error("journal spent provider-account watermark regressed");
				if (
					old.externalCommittedMicros >
						(account?.externalCommittedMicros ?? 0) &&
					!event.reconciliationEvidenceRef
				)
					throw new Error(
						"journal external account liability reduction lacks evidence",
					);
			}
		}
		rememberFinancialHistory(event.snapshot);
		current = clone(BudgetLedgerSnapshotSchema, event.snapshot);
		reservations = new Map(
			event.reservations.map((reservation) => [
				reservation.reservationId,
				clone(BudgetReservationSchema, reservation),
			]),
		);
		replayed.set(current.seq, digest);
		policyBindings.set(policyKey, policyFingerprint(current));
		assertProjection();
	}
	function held(rows = reservations): number {
		return add(
			...[...rows.values()]
				.filter((row) => row.status === "held" || row.status === "uncertain")
				.map((row) => row.reservedMicros),
		);
	}
	function active(rows = reservations): BudgetReservation[] {
		return [...rows.values()].filter(
			(row) => row.status === "held" || row.status === "uncertain",
		);
	}
	function unboundedCount(rows = reservations): number {
		return active(rows).filter((row) => row.unboundedExposure).length;
	}
	function updateDimensions(
		snapshot: BudgetLedgerSnapshot,
		rows: Map<string, BudgetReservation>,
	): void {
		const holding = active(rows);
		for (const account of snapshot.providerAccounts)
			account.reservedMicros = add(
				...holding.flatMap((row) =>
					row.providerAccounts
						.filter(
							(entry) => entry.providerAccountId === account.providerAccountId,
						)
						.map((entry) => entry.liabilityMicros),
				),
			);
		for (const entitlement of snapshot.entitlements)
			entitlement.reservedUnits = add(
				...holding.flatMap((row) =>
					row.entitlementClaims
						.filter((entry) => sameEntitlementScope(entry, entitlement))
						.map((entry) => entry.units),
				),
			);
		for (const row of holding) {
			if (
				row.providerAccounts.some(
					(entry) =>
						!snapshot.providerAccounts.some(
							(account) =>
								account.providerAccountId === entry.providerAccountId,
						),
				) ||
				row.entitlementClaims.some(
					(entry) =>
						!snapshot.entitlements.some((bucket) =>
							sameEntitlementScope(bucket, entry),
						),
				)
			)
				throw new Error("active financial scopes cannot be removed");
		}
	}
	function assertProjection(): void {
		if (
			held() !== current.reservedMicros ||
			unboundedCount() !== current.unboundedExposureCount ||
			(unboundedCount() > 0 && active().some((row) => !row.unboundedExposure))
		)
			throw new Error("budget journal exposure mismatch");
		const projected = clone(BudgetLedgerSnapshotSchema, current);
		updateDimensions(projected, reservations);
		if (
			projected.providerAccounts.some(
				(row, index) =>
					row.reservedMicros !==
					current.providerAccounts[index]?.reservedMicros,
			) ||
			projected.entitlements.some(
				(row, index) =>
					row.reservedUnits !== current.entitlements[index]?.reservedUnits,
			)
		)
			throw new Error("budget journal financial dimension mismatch");
	}
	assertProjection();
	function save(
		type: string,
		next: BudgetLedgerSnapshot,
		rows: Map<string, BudgetReservation>,
		reconciliationEvidenceRef = "",
	): void {
		const expectedSeq = current.seq;
		if (!next.identity) throw new Error("budget identity missing");
		assertFinancialHistory(next, type);
		const policyKey = budgetIdentityKey(next.identity);
		if (
			policyBindings.has(policyKey) &&
			policyBindings.get(policyKey) !== policyFingerprint(next)
		)
			throw new Error("policy revision reused for different financial limits");
		next.seq = expectedSeq + 1;
		next.reservedMicros = held(rows);
		next.unboundedExposureCount = unboundedCount(rows);
		updateDimensions(next, rows);
		const event = create(BudgetAuthorityEventSchema, {
			type,
			snapshot: next,
			reservations: [...rows.values()],
			reconciliationEvidenceRef,
		});
		const committed: unknown = options.commit?.(
			clone(BudgetAuthorityEventSchema, event),
			expectedSeq,
		);
		if (committed instanceof Promise)
			throw new Error(
				"budget commit must append synchronously before acknowledgement",
			);
		rememberFinancialHistory(next);
		current = clone(BudgetLedgerSnapshotSchema, next);
		policyBindings.set(policyKey, policyFingerprint(current));
		reservations = new Map(
			[...rows].map(([id, row]) => [id, clone(BudgetReservationSchema, row)]),
		);
	}
	function change(
		id: string,
		status: string,
		actualMicros?: number,
		evidence?: BudgetSettlementEvidence,
	): BudgetReservation {
		const existing = reservations.get(id);
		if (!existing) throw new Error("unknown budget reservation");
		if (status === "released" && existing.executionDigest)
			throw new Error(
				"execution-claimed reservation requires final usage settlement",
			);
		if (existing.status === status) {
			if (actualMicros !== undefined && existing.actualMicros !== actualMicros)
				throw new Error("settlement replay differs");
			if (
				evidence &&
				(existing.usageEvidenceRef !== evidence.usageEvidenceRef ||
					existing.sourceStoppedEvidenceRef !==
						evidence.sourceStoppedEvidenceRef)
			)
				throw new Error("settlement evidence replay differs");
			if (
				evidence &&
				existing.settlementEvidence &&
				toJsonString(
					BudgetSettlementEvidenceSchema,
					existing.settlementEvidence,
				) !==
					toJsonString(
						BudgetSettlementEvidenceSchema,
						create(BudgetSettlementEvidenceSchema, {
							...evidence,
							providerAccounts: [...(evidence.providerAccounts ?? [])],
							entitlementClaims: [...(evidence.entitlementClaims ?? [])],
						}),
					)
			)
				throw new Error("settlement evidence replay differs");
			return clone(BudgetReservationSchema, existing);
		}
		if (existing.status === "settled" || existing.status === "released")
			throw new Error("reservation is terminal");
		const rows = new Map(reservations);
		const next = clone(BudgetLedgerSnapshotSchema, current);
		const updated = clone(BudgetReservationSchema, existing);
		updated.status = status;
		updated.ledgerSeq = next.seq + 1;
		if (actualMicros !== undefined) {
			updated.actualMicros = budgetMicros(actualMicros);
			next.spentMicros = add(next.spentMicros, actualMicros);
			const accounts = evidence?.providerAccounts ?? [];
			const claims = evidence?.entitlementClaims ?? [];
			if (
				accounts.length !== existing.providerAccounts.length ||
				claims.length !== existing.entitlementClaims.length ||
				new Set(accounts.map((row) => row.providerAccountId)).size !==
					accounts.length ||
				new Set(claims.map(entitlementScopeKey)).size !== claims.length
			)
				throw new Error(
					"complete account and entitlement usage evidence required",
				);
			if (
				accounts.length &&
				add(...accounts.map((row) => row.liabilityMicros)) !== actualMicros
			)
				throw new Error("actual provider charges must equal actual total");
			for (const account of accounts) {
				const target = next.providerAccounts.find(
					(row) => row.providerAccountId === account.providerAccountId,
				);
				if (
					!target ||
					!existing.providerAccounts.some(
						(row) => row.providerAccountId === account.providerAccountId,
					)
				)
					throw new Error("foreign provider-account settlement");
				target.spentMicros = add(target.spentMicros, account.liabilityMicros);
			}
			for (const claim of claims) {
				const target = next.entitlements.find((row) =>
					sameEntitlementScope(row, claim),
				);
				if (
					!target ||
					!existing.entitlementClaims.some((row) =>
						sameEntitlementScope(row, claim),
					)
				)
					throw new Error("foreign entitlement settlement");
				target.remainingUnits = Math.max(
					0,
					target.remainingUnits - budgetMicros(claim.units),
				);
			}
		}
		if (evidence) {
			updated.usageEvidenceRef = evidence.usageEvidenceRef;
			updated.sourceStoppedEvidenceRef = evidence.sourceStoppedEvidenceRef;
			updated.settlementEvidence = create(BudgetSettlementEvidenceSchema, {
				...evidence,
				providerAccounts: [...(evidence.providerAccounts ?? [])],
				entitlementClaims: [...(evidence.entitlementClaims ?? [])],
			});
		}
		rows.set(id, updated);
		save(
			existing.unboundedExposure && actualMicros !== undefined
				? "budget.UnboundedUsageRecorded"
				: actualMicros !== undefined && actualMicros > existing.reservedMicros
					? "budget.OverrunRecorded"
					: `budget.Reservation${status.charAt(0).toUpperCase()}${status.slice(1)}`,
			next,
			rows,
		);
		return clone(BudgetReservationSchema, updated);
	}
	return {
		persistence: options.commit ? "durable-cas" : "memory",
		read(now) {
			validateBudgetSnapshot(current, now);
			return clone(BudgetLedgerSnapshotSchema, current);
		},
		lookup(id) {
			const row = reservations.get(id);
			return row ? clone(BudgetReservationSchema, row) : undefined;
		},
		claimExecution(input) {
			if (input.expectedSeq !== undefined && input.expectedSeq !== current.seq)
				throw new Error("budget sequence conflict");
			const previous = reservations.get(input.reservationId);
			if (
				!previous ||
				!input.executionDigest ||
				previous.requestDigest !== input.requestDigest ||
				!["held", "uncertain"].includes(previous.status)
			)
				throw new Error(
					"execution adoption requires the exact live financial reservation",
				);
			if (
				previous.unboundedExposure &&
				(previous.unpricedPolicyProof === undefined ||
					previous.unpricedScopeProof === undefined ||
					scopeTrust?.isCurrent(
						clone(IacUnpricedScopeProofSchema, previous.unpricedScopeProof),
					) !== true ||
					input.now === undefined ||
					!Number.isFinite(Date.parse(input.now)) ||
					Date.parse(previous.unpricedPolicyProof.observedAt) >
						Date.parse(input.now) ||
					Date.parse(previous.unpricedPolicyProof.validUntil) <=
						Date.parse(input.now))
			)
				throw new Error("unpriced policy authorization is stale");
			if (
				previous.fenceSettlementGuard &&
				previous.fenceSettlementGuard.executionDigest !== input.executionDigest
			)
				throw new Error(
					"fenced reservation requires its admitted execution identity",
				);
			if (previous.executionDigest) {
				if (previous.executionDigest !== input.executionDigest)
					throw new Error(
						"financial reservation already claimed by another execution",
					);
				return clone(BudgetReservationSchema, previous);
			}
			if (
				previous.iacPricingPin &&
				!previous.fenceSettlementGuard &&
				!pricedSettlementTrust
			)
				throw new BudgetAdmissionDeniedError(
					"budget.settlement-unavailable",
					"an independent priced IaC settlement authority is required",
				);
			if (
				!previous.identity ||
				!current.identity ||
				budgetIdentityKey(previous.identity) !==
					budgetIdentityKey(current.identity)
			)
				throw new Error("unclaimed reservation belongs to a superseded policy");
			const updated = clone(BudgetReservationSchema, previous);
			updated.executionDigest = input.executionDigest;
			updated.ledgerSeq = current.seq + 1;
			const rows = new Map(reservations);
			rows.set(updated.reservationId, updated);
			save(
				"budget.ExecutionClaimed",
				clone(BudgetLedgerSnapshotSchema, current),
				rows,
			);
			return clone(BudgetReservationSchema, updated);
		},
		reserve(input) {
			validateBudgetSnapshot(current, input.now);
			validateHostingQuote(input.quote, input.now);
			if (
				input.iacPricingPin &&
				(!validIacPin(input.iacPricingPin, input.quote.financialPlanHash) ||
					input.iacPricingPin.validUntil !== input.quote.validUntil)
			)
				throw new Error("priced IaC pin does not match its financial quote");
			if (
				!current.identity ||
				budgetIdentityKey(input.identity) !==
					budgetIdentityKey(current.identity)
			)
				throw new Error("budget identity or policy revision changed");
			if (
				!input.reservationId ||
				input.requestDigest !== input.quote.requestDigest ||
				input.quote.ownerTenantId !== current.identity.tenantId
			)
				throw new Error("budget reservation scope mismatch");
			const previous = reservations.get(input.reservationId);
			const quoteDigest = createHash("sha256")
				.update(toJsonString(HostingQuoteSchema, input.quote))
				.digest("hex");
			if (previous) {
				if (
					!previous.identity ||
					budgetIdentityKey(previous.identity) !==
						budgetIdentityKey(current.identity)
				)
					throw new Error("reservation belongs to a superseded budget policy");
				if (
					previous.requestDigest !== input.requestDigest ||
					previous.quoteDigest !== quoteDigest ||
					JSON.stringify(previous.iacPricingPin) !==
						JSON.stringify(input.iacPricingPin) ||
					!!previous.fenceSettlementGuard !== !!input.fenceSettlementGuard ||
					(input.fenceSettlementGuard &&
						previous.fenceSettlementGuard &&
						toJsonString(
							BudgetFenceSettlementGuardSchema,
							fenced.createGuard(previous, input.fenceSettlementGuard),
						) !==
							toJsonString(
								BudgetFenceSettlementGuardSchema,
								previous.fenceSettlementGuard,
							))
				)
					throw new Error("budget reservation replay differs");
				if (previous.status === "released")
					throw new Error("released reservation cannot authorize execution");
				return clone(BudgetReservationSchema, previous);
			}
			if (
				input.iacPricingPin &&
				!input.fenceSettlementGuard &&
				!pricedSettlementTrust
			)
				throw new BudgetAdmissionDeniedError(
					"budget.settlement-unavailable",
					"an independent priced IaC settlement authority is required",
				);
			if (unboundedCount() > 0)
				throw new BudgetAdmissionDeniedError(
					"budget.unbounded-exposure",
					"bounded budget admission is unavailable while unbounded exposure is active",
				);
			if (
				input.fenceSettlementGuard &&
				(input.quote.yardId !== input.fenceSettlementGuard.destination.yardId ||
					input.quote.providerId !==
						input.fenceSettlementGuard.destination.providerId)
			)
				throw new Error("fenced destination differs from the admitted quote");
			if (current.seq !== input.expectedSeq)
				throw new Error("budget sequence conflict");
			if (
				current.providerAccounts.length &&
				!input.quote.providerAccounts.length
			)
				throw new Error("provider-account exposure evidence required");
			for (const exposure of input.quote.providerAccounts) {
				const account = current.providerAccounts.find(
					(row) => row.providerAccountId === exposure.providerAccountId,
				);
				if (!account)
					throw new Error("provider-account budget exhausted or unsupported");
				if (
					add(
						account.spentMicros,
						account.reservedMicros,
						account.externalCommittedMicros,
						exposure.liabilityMicros,
					) > account.limitMicros
				)
					throw new BudgetAdmissionDeniedError(
						"provider.exhausted",
						"provider-account budget exhausted or unsupported",
					);
			}
			for (const claim of input.quote.entitlementClaims) {
				const bucket = current.entitlements.find((row) =>
					sameEntitlementScope(row, claim),
				);
				if (
					!bucket ||
					!current.identity ||
					bucket.periodId !== current.identity.periodId ||
					Date.parse(bucket.observedAt) > Date.parse(input.now) ||
					Date.parse(bucket.validUntil) <= Date.parse(input.now)
				)
					throw new Error("entitlement exhausted, stale or unsupported");
				if (add(bucket.reservedUnits, claim.units) > bucket.remainingUnits)
					throw new BudgetAdmissionDeniedError(
						"entitlement.exhausted",
						"entitlement exhausted, stale or unsupported",
					);
			}
			if (input.quote.liabilityBoundMicros === undefined)
				throw new Error("quote liability bound missing");
			if (
				add(
					current.spentMicros,
					current.reservedMicros,
					current.unresolvedMicros,
					current.recoveryReserveMicros,
					current.externalCommittedMicros,
					input.quote.liabilityBoundMicros,
				) > current.limitMicros
			)
				throw new BudgetAdmissionDeniedError(
					"budget.exhausted",
					"budget exhausted",
				);
			const reservation = create(BudgetReservationSchema, {
				reservationId: input.reservationId,
				identity: input.identity,
				requestDigest: input.requestDigest,
				quoteId: input.quote.quoteId,
				quoteDigest,
				reservedMicros: input.quote.liabilityBoundMicros,
				providerAccounts: input.quote.providerAccounts,
				entitlementClaims: input.quote.entitlementClaims,
				financialPlanHash: input.quote.financialPlanHash,
				iacPricingPin: input.iacPricingPin,
				status: "held",
				ledgerSeq: current.seq + 1,
			});
			if (input.fenceSettlementGuard)
				reservation.fenceSettlementGuard = fenced.createGuard(
					reservation,
					input.fenceSettlementGuard,
				);
			const rows = new Map(reservations);
			rows.set(input.reservationId, reservation);
			save(
				"budget.ReservationHeld",
				clone(BudgetLedgerSnapshotSchema, current),
				rows,
			);
			return clone(BudgetReservationSchema, reservation);
		},
		reserveUnbounded(input) {
			validateBudgetSnapshot(current, input.now);
			if (
				!current.identity ||
				!input.identity ||
				budgetIdentityKey(input.identity) !==
					budgetIdentityKey(current.identity)
			)
				throw new Error("budget identity or policy revision changed");
			const digestPattern = /^sha256:[a-f0-9]{64}$/u;
			const ids = [...input.providerAccountIds].sort();
			const proof = clone(IacUnpricedPolicyProofSchema, input.policyProof);
			const scope = clone(IacUnpricedScopeProofSchema, input.scopeProof);
			if (
				!boundedName(input.reservationId, 204) ||
				!digestPattern.test(input.requestDigest) ||
				!digestPattern.test(input.inventoryHash) ||
				!validUnpricedProof(
					proof,
					input.identity,
					input.requestDigest,
					input.inventoryHash,
				) ||
				Date.parse(proof.observedAt) > Date.parse(input.now) ||
				Date.parse(proof.validUntil) <= Date.parse(input.now) ||
				ids.length === 0 ||
				ids.length > 256 ||
				current.entitlements.length !== 0 ||
				new Set(ids).size !== ids.length ||
				ids.some(
					(id) =>
						!boundedName(id) ||
						!current.providerAccounts.some(
							(account) => account.providerAccountId === id,
						),
				)
			)
				throw new Error(
					"unbounded exposure requires a bounded, registered target scope",
				);
			if (
				!validScopeProof(scope, input.identity, ids) ||
				Date.parse(scope.observedAt) > Date.parse(input.now) ||
				scopeTrust?.verify(clone(IacUnpricedScopeProofSchema, scope)) !==
					true ||
				scopeTrust.isCurrent(clone(IacUnpricedScopeProofSchema, scope)) !== true
			)
				throw new BudgetAdmissionDeniedError(
					"budget.scope-unverified",
					"exclusive financial scope could not be authenticated",
				);
			const fingerprint = unboundedFingerprint({
				requestDigest: input.requestDigest,
				inventoryHash: input.inventoryHash,
				policyProof: proof,
				scopeProof: scope,
				identity: input.identity,
				providerAccountIds: ids,
			});
			const previous = reservations.get(input.reservationId);
			if (previous) {
				if (
					!previous.unboundedExposure ||
					previous.requestDigest !== input.requestDigest ||
					previous.quoteDigest !== fingerprint ||
					previous.status === "released"
				)
					throw new Error("unbounded reservation replay differs");
				return clone(BudgetReservationSchema, previous);
			}
			if (current.seq !== input.expectedSeq)
				throw new Error("budget sequence conflict");
			if (active().some((row) => !row.unboundedExposure))
				throw new BudgetAdmissionDeniedError(
					"budget.bounded-exposure",
					"unbounded admission would invalidate a bounded reservation",
				);
			if (unboundedCount() >= 256)
				throw new BudgetAdmissionDeniedError(
					"budget.exposure-limit",
					"unbounded exposure limit reached",
				);
			const reservation = create(BudgetReservationSchema, {
				reservationId: input.reservationId,
				identity: input.identity,
				requestDigest: input.requestDigest,
				quoteId: "",
				quoteDigest: fingerprint,
				financialPlanHash: input.inventoryHash,
				unboundedExposure: true,
				unpricedPolicyProof: proof,
				unpricedScopeProof: scope,
				status: "held",
				ledgerSeq: current.seq + 1,
				providerAccounts: ids.map((providerAccountId) => ({
					providerAccountId,
					liabilityMicros: 0,
				})),
				entitlementClaims: current.entitlements.map((row) => ({
					kind: row.kind,
					bucketId: row.bucketId,
					unit: row.unit,
					units: 0,
				})),
			});
			const rows = new Map(reservations);
			rows.set(input.reservationId, reservation);
			save(
				"budget.UnboundedExposureHeld",
				clone(BudgetLedgerSnapshotSchema, current),
				rows,
			);
			return clone(BudgetReservationSchema, reservation);
		},
		revalidateUnbounded(input) {
			validateBudgetSnapshot(current, input.now);
			const row = reservations.get(input.reservationId);
			if (
				row?.status !== "held" ||
				!row.unboundedExposure ||
				row.requestDigest !== input.requestDigest ||
				row.financialPlanHash !== input.inventoryHash ||
				row.executionDigest !== input.executionDigest ||
				!row.identity ||
				!current.identity ||
				budgetIdentityKey(row.identity) !==
					budgetIdentityKey(current.identity) ||
				!row.unpricedPolicyProof ||
				!row.unpricedScopeProof ||
				stableHash(
					toJson(IacUnpricedPolicyProofSchema, row.unpricedPolicyProof, {
						alwaysEmitImplicit: true,
					}),
				) !== input.policyProofHash ||
				stableHash(
					toJson(IacUnpricedScopeProofSchema, row.unpricedScopeProof, {
						alwaysEmitImplicit: true,
					}),
				) !== input.scopeProofHash ||
				!validUnpricedProof(
					row.unpricedPolicyProof,
					row.identity,
					input.requestDigest,
					input.inventoryHash,
				) ||
				Date.parse(row.unpricedPolicyProof.observedAt) >
					Date.parse(input.now) ||
				Date.parse(row.unpricedPolicyProof.validUntil) <=
					Date.parse(input.now) ||
				!validScopeProof(
					row.unpricedScopeProof,
					row.identity,
					row.providerAccounts.map((account) => account.providerAccountId),
				) ||
				scopeTrust?.verify(
					clone(IacUnpricedScopeProofSchema, row.unpricedScopeProof),
				) !== true ||
				scopeTrust.isCurrent(
					clone(IacUnpricedScopeProofSchema, row.unpricedScopeProof),
				) !== true
			)
				return false;
			return true;
		},
		revalidatePriced(input) {
			validateBudgetSnapshot(current, input.now);
			const row = reservations.get(input.reservationId);
			if (
				row?.status !== "held" ||
				row.unboundedExposure ||
				(!row.fenceSettlementGuard && !pricedSettlementTrust) ||
				!row.identity ||
				!current.identity ||
				budgetIdentityKey(row.identity) !==
					budgetIdentityKey(current.identity) ||
				row.identity.tenantId !== input.tenantId ||
				row.requestDigest !== input.requestDigest ||
				!row.iacPricingPin ||
				!validIacPin(row.iacPricingPin, row.financialPlanHash) ||
				row.iacPricingPin.planDigest !== input.planDigest ||
				row.iacPricingPin.inventoryHash !== input.inventoryHash ||
				row.iacPricingPin.modelHash !== input.modelHash ||
				row.iacPricingPin.quoteHash !== input.quoteHash ||
				Date.parse(row.iacPricingPin.validUntil) <= Date.parse(input.now) ||
				input.requestDigest !==
					stableHash({
						requestId: input.requestId,
						targetId: input.targetId,
						tenantId: input.tenantId,
						financialPlanHash: row.financialPlanHash,
					}) ||
				row.executionDigest !==
					stableHash({
						kind: "iac-target-execution",
						requestDigest: input.requestDigest,
						planDigest: input.planDigest,
					})
			)
				return false;
			return true;
		},
		settle(id, actualMicros, evidence) {
			if (!evidence)
				throw new Error(
					"authoritative usage and confirmed source retirement evidence required",
				);

			const proof = clone(
				BudgetSettlementEvidenceSchema,
				create(BudgetSettlementEvidenceSchema, {
					...evidence,
					providerAccounts: [...(evidence.providerAccounts ?? [])],
					entitlementClaims: [...(evidence.entitlementClaims ?? [])],
				}),
			);
			if (!proof.usageEvidenceRef || !proof.sourceStoppedEvidenceRef)
				throw new Error(
					"authoritative usage and confirmed source retirement evidence required",
				);
			budgetMicros(actualMicros);
			const existing = reservations.get(id);
			if (!existing) throw new Error("unknown budget reservation");

			if (
				existing.status === "settled" &&
				(existing.iacPricingPin || existing.unboundedExposure)
			)
				return change(id, "settled", actualMicros, proof);
			if (existing.iacPricingPin && !existing.fenceSettlementGuard) {
				if (
					!existing.executionDigest ||
					!boundedName(proof.financeSignature, 4096) ||
					pricedSettlementTrust?.verify({
						reservation: clone(BudgetReservationSchema, existing),
						actualMicros,
						evidence: clone(BudgetSettlementEvidenceSchema, proof),
					}) !== true
				)
					throw new Error(
						"authenticated priced IaC final usage and permanent source retirement are required",
					);
			}
			if (existing.unboundedExposure) {
				if (
					!existing.executionDigest ||
					!boundedName(proof.financeSignature, 4096) ||
					scopeTrust?.settlement({
						reservation: clone(BudgetReservationSchema, existing),
						actualMicros,
						evidence: clone(BudgetSettlementEvidenceSchema, proof),
					}) !== true
				)
					throw new Error(
						"authenticated final usage and permanent source retirement are required",
					);
			}
			fenced.settle(existing, actualMicros, proof);
			return change(id, "settled", actualMicros, proof);
		},
		uncertain(id) {
			return change(id, "uncertain");
		},
		release(id, confirmedUnused, evidenceRef) {
			if (confirmedUnused !== true || !evidenceRef)
				throw new Error("confirmed unused funds and evidence required");
			return change(id, "released", undefined, {
				usageEvidenceRef: evidenceRef,
				sourceStoppedEvidenceRef: evidenceRef,
			});
		},
		configure(snapshot, expectedSeq, now, evidence) {
			validateBudgetSnapshot(snapshot, now);
			if (
				current.seq !== expectedSeq ||
				!current.identity ||
				!snapshot.identity
			)
				throw new Error("budget sequence conflict");
			if (
				current.identity.tenantId !== snapshot.identity.tenantId ||
				current.identity.budgetId !== snapshot.identity.budgetId
			)
				throw new Error("authority cannot change budget ownership");
			if (
				unboundedCount() > 0 &&
				financialScopes(snapshot) !== financialScopes(current)
			)
				throw new Error(
					"financial scopes cannot change with unbounded exposure",
				);
			if (
				snapshot.unresolvedMicros < current.unresolvedMicros &&
				!evidence?.liabilityResolutionEvidenceRef
			)
				throw new Error("unresolved liability reduction requires evidence");
			if (
				snapshot.externalCommittedMicros < current.externalCommittedMicros &&
				!evidence?.liabilityResolutionEvidenceRef
			)
				throw new Error("external commitment reduction requires evidence");
			const samePeriod =
				current.identity.tenantId === snapshot.identity.tenantId &&
				current.identity.budgetId === snapshot.identity.budgetId &&
				current.identity.periodId === snapshot.identity.periodId;
			if (!samePeriod && active().length > 0)
				throw new Error(
					"reconcile outstanding or uncertain commitments before period reset",
				);
			if (samePeriod && snapshot.spentMicros < current.spentMicros)
				throw new Error(
					"spend watermark cannot decrease within a budget period",
				);
			if (
				samePeriod &&
				(Date.parse(snapshot.observedAt) < Date.parse(current.observedAt) ||
					(snapshot.observedAt === current.observedAt &&
						snapshot.spentMicros !== current.spentMicros &&
						!evidence?.liabilityResolutionEvidenceRef))
			)
				throw new Error(
					"changed spend requires a newer observation or reconciliation evidence",
				);
			if (samePeriod) {
				for (const old of current.providerAccounts) {
					const account = snapshot.providerAccounts.find(
						(row) => row.providerAccountId === old.providerAccountId,
					);
					if (!account && old.spentMicros > 0)
						throw new Error(
							"spent provider-account watermarks cannot be removed within a period",
						);
					if (
						!account &&
						old.externalCommittedMicros > 0 &&
						!evidence?.liabilityResolutionEvidenceRef
					)
						throw new Error(
							"external account commitment reduction requires evidence",
						);
				}
			}
			if (samePeriod)
				for (const account of snapshot.providerAccounts) {
					const old = current.providerAccounts.find(
						(row) => row.providerAccountId === account.providerAccountId,
					);
					if (old && account.spentMicros < old.spentMicros)
						throw new Error("provider-account spend watermark cannot decrease");
					if (
						old &&
						account.externalCommittedMicros < old.externalCommittedMicros &&
						!evidence?.liabilityResolutionEvidenceRef
					)
						throw new Error(
							"external account commitment reduction requires evidence",
						);
				}
			for (const bucket of snapshot.entitlements) {
				const old = current.entitlements.find((row) =>
					sameEntitlementScope(row, bucket),
				);
				if (
					old &&
					old.reservedUnits > 0 &&
					(old.periodId !== bucket.periodId || old.unit !== bucket.unit)
				)
					throw new Error("active entitlement cannot change unit or period");
				if (
					old &&
					old.periodId === bucket.periodId &&
					(Date.parse(bucket.observedAt) < Date.parse(old.observedAt) ||
						(bucket.observedAt === old.observedAt &&
							bucket.remainingUnits !== old.remainingUnits))
				)
					throw new Error(
						"entitlement observation must advance with changed remaining allocation",
					);
			}
			if (
				budgetIdentityKey(snapshot.identity) ===
					budgetIdentityKey(current.identity) &&
				(snapshot.limitMicros !== current.limitMicros ||
					snapshot.recoveryReserveMicros !== current.recoveryReserveMicros ||
					snapshot.providerAccounts.some(
						(account) =>
							current.providerAccounts.find(
								(old) => old.providerAccountId === account.providerAccountId,
							)?.limitMicros !== account.limitMicros,
					))
			)
				throw new Error("cap change requires a policy revision");
			const next = clone(BudgetLedgerSnapshotSchema, snapshot);
			save(
				samePeriod ? "budget.PolicyRevised" : "budget.PeriodReset",
				next,
				samePeriod ? reservations : new Map(),
				evidence?.liabilityResolutionEvidenceRef,
			);
		},
	};
}
