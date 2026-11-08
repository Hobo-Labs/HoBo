import { createHash } from "node:crypto";
import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { budgetScopeIdentityKey } from "@hobo/core";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	type BudgetIdentity,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	type BudgetReservation,
	BudgetReservationSchema,
	BudgetSettlementEvidenceSchema,
	type BudgetSettlementEvidence as GeneratedSettlementEvidence,
	type HostingQuote,
	HostingQuoteSchema,
} from "./_generated/yard_placement_pb.js";

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
	ProviderAccountExposureSchema,
} from "./_generated/yard_placement_pb.js";
export type {
	BudgetAuthorityEvent,
	BudgetIdentity,
	BudgetLedgerSnapshot,
	BudgetReservation,
	HostingQuote,
};
export type BudgetSettlementEvidence = Pick<
	GeneratedSettlementEvidence,
	"usageEvidenceRef" | "sourceStoppedEvidenceRef"
> &
	Partial<
		Pick<GeneratedSettlementEvidence, "providerAccounts" | "entitlementClaims">
	>;

export type BudgetAdmissionDeniedCode =
	| "budget.exhausted"
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
		new Set(snapshot.entitlements.map((row) => row.bucketId)).size !==
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
		new Set(quote.entitlementClaims.map((row) => row.bucketId)).size !==
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
	}): BudgetReservation;
	reserve(input: {
		reservationId: string;
		requestDigest: string;
		quote: HostingQuote;
		identity: BudgetIdentity;
		expectedSeq: number;
		now: string;
	}): BudgetReservation;
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
	) => JSON.stringify([bucket.periodId, bucket.bucketId]);
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
			if (
				(row.status === "held" || row.status === "uncertain") &&
				row.identity.periodId !== event.snapshot.identity.periodId
			)
				throw new Error("active journal reservation period mismatch");
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
						.filter((entry) => entry.bucketId === entitlement.bucketId)
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
						!snapshot.entitlements.some(
							(bucket) => bucket.bucketId === entry.bucketId,
						),
				)
			)
				throw new Error("active financial scopes cannot be removed");
		}
	}
	function assertProjection(): void {
		if (held() !== current.reservedMicros)
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
				new Set(claims.map((row) => row.bucketId)).size !== claims.length
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
				const target = next.entitlements.find(
					(row) => row.bucketId === claim.bucketId && row.unit === claim.unit,
				);
				if (
					!target ||
					!existing.entitlementClaims.some(
						(row) => row.bucketId === claim.bucketId && row.unit === claim.unit,
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
			actualMicros !== undefined && actualMicros > existing.reservedMicros
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
			if (previous.executionDigest) {
				if (previous.executionDigest !== input.executionDigest)
					throw new Error(
						"financial reservation already claimed by another execution",
					);
				return clone(BudgetReservationSchema, previous);
			}
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
					previous.quoteDigest !== quoteDigest
				)
					throw new Error("budget reservation replay differs");
				if (previous.status === "released")
					throw new Error("released reservation cannot authorize execution");
				return clone(BudgetReservationSchema, previous);
			}
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
				const bucket = current.entitlements.find(
					(row) => row.bucketId === claim.bucketId && row.unit === claim.unit,
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
				status: "held",
				ledgerSeq: current.seq + 1,
			});
			const rows = new Map(reservations);
			rows.set(input.reservationId, reservation);
			save(
				"budget.ReservationHeld",
				clone(BudgetLedgerSnapshotSchema, current),
				rows,
			);
			return clone(BudgetReservationSchema, reservation);
		},
		settle(id, actualMicros, evidence) {
			if (!evidence?.usageEvidenceRef || !evidence.sourceStoppedEvidenceRef)
				throw new Error(
					"authoritative usage and confirmed source retirement evidence required",
				);
			return change(id, "settled", actualMicros, evidence);
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
				const old = current.entitlements.find(
					(row) => row.bucketId === bucket.bucketId,
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
