import { createHash } from "node:crypto";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	type AsyncBudgetAdmissionAuthority,
	type BudgetAdmissionAuthority,
	BudgetAdmissionDeniedError,
	type BudgetIdentity,
	BudgetIdentitySchema,
	type BudgetLedgerSnapshot,
	type BudgetReservation,
	type BudgetSettlementEvidence,
	type HostingQuote,
	HostingQuoteSchema,
	validateHostingQuote,
} from "@hobo/broker";
import {
	type BudgetPolicyEvaluationContext,
	canonicalBudgetPolicyJson,
	evaluateBudgetPolicy,
	parseBudgetPolicyJson,
} from "@hobo/core";
import {
	type Lease,
	SandboxAllowanceSchema,
	SandboxPricingSchema,
} from "./_generated/ci_pb.js";

/** Ports only: financial records remain the Broker's generated, shared ledger records. */
export interface CiSharedBudgetHooks {
	reserve(lease: Lease, measurements?: CiPolicyMeasurements): BudgetReservation;
	claim(lease: Lease, measurements?: CiPolicyMeasurements): BudgetReservation;
	uncertain(lease: Lease): BudgetReservation;
	settle(lease: Lease, evidence: BudgetSettlementEvidence): BudgetReservation;
	releaseUnused(lease: Lease, evidenceRef: string): BudgetReservation;
}
/** Store-owned workload-local measurements captured under the lease transaction. */
export type CiPolicyMeasurements =
	BudgetPolicyEvaluationContext["measurements"];
export type CiAsyncSharedBudgetHooks = {
	[K in keyof CiSharedBudgetHooks]: (
		...args: Parameters<CiSharedBudgetHooks[K]>
	) => Promise<ReturnType<CiSharedBudgetHooks[K]>>;
};
export type { AsyncBudgetAdmissionAuthority } from "@hobo/broker";

export interface CiSharedBudgetOptions {
	/** A trusted quote publisher itemizes every provider charge and credit claim. */
	quoteLease(lease: Lease): HostingQuote;
	/** Optional host restriction. It must agree with the pinned common policy. */
	mode?: "strict" | "conservative";
	/** Trusted host integration revalidates provider scope, amount, time and native adapter incarnation. */
	verifyProviderLiabilityBound?: (
		lease: Lease,
		quote: HostingQuote,
		at: string,
	) => boolean;
	/** Trusted native publisher must prove complete runner/Sandbox credit quantities,
	 * their scales and units, and original provider-account bucket ownership. */
	verifyAllocationCoverage?: (
		lease: Lease,
		quote: HostingQuote,
		ledger: BudgetLedgerSnapshot,
	) => boolean;
	/** Verify authoritative final usage AND stopped-source evidence against this exact execution. */
	verifyFinalUsage?: (
		lease: Lease,
		evidence: BudgetSettlementEvidence,
	) => boolean;
	/** Verify a durable cancelled-before-claim CAS receipt, never absence or a deadline. */
	verifyUnused?: (lease: Lease, evidenceRef: string) => boolean;
	now?: () => string;
}

function hash(value: readonly (string | number)[]): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function required(value: string): string {
	if (!value || value.length > 1000)
		throw new Error("complete CI financial identity required");
	return value;
}
function integer(value: number, positive = false): number {
	if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
		throw new Error("invalid CI financial quantity");
	return value;
}
function quantity(value: number): number {
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error("invalid CI financial quantity");
	return value;
}
function jobScope(lease: Lease): (string | number)[] {
	if (lease.pipelineId)
		return [
			"hobo.ci.pipeline/v1",
			required(lease.budgetTenantId),
			required(lease.budgetId),
			required(lease.accountId),
			required(lease.pipelineId),
			required(lease.pipelineDigest),
			integer(lease.runAttempt, true),
			integer(lease.budgetAdmissionAttempt, true),
		];
	return [
		"hobo.ci.job/v1",
		required(lease.budgetTenantId),
		required(lease.budgetId),
		required(lease.accountId),
		integer(lease.installationId, true),
		integer(lease.repositoryId, true),
		integer(lease.originalRunId, true),
		integer(lease.runAttempt, true),
		integer(lease.jobId, true),
		integer(lease.budgetAdmissionAttempt, true),
		lease.pipelineId,
		lease.pipelineDigest,
	];
}
/** Independent of random lease IDs; a retry cannot buy a second hold for the same job. */
export function ciReservationId(lease: Lease): string {
	return `ci:${hash(jobScope(lease))}`;
}
export function ciRequestDigest(lease: Lease): string {
	return hash([
		...jobScope(lease),
		"request",
		lease.pipelineId ? "native-pipeline" : required(lease.repository),
	]);
}
/** Pins the whole approved financial plan, including price duration and both resource schedules. */
export function ciFinancialPlanHash(lease: Lease): string {
	return hash([
		...jobScope(lease),
		"financial",
		required(lease.provider),
		required(lease.providerAccountId),
		required(lease.offerId),
		required(lease.budgetPeriodId),
		required(lease.budgetPolicyRevision),
		lease.budgetPolicyDigest,
		quantity(lease.reservedMinutes),
		quantity(lease.reservedFreeMinutes),
		integer(lease.reservedPaidMicros),
		integer(lease.priceMicrosPerMinute),
		lease.freeValidUntil,
		lease.queueDeadlineAt,
		lease.sandboxPricing
			? toJsonString(SandboxPricingSchema, lease.sandboxPricing)
			: "",
		lease.sandboxReservedAllowance
			? toJsonString(SandboxAllowanceSchema, lease.sandboxReservedAllowance)
			: "",
	]);
}
/** One concrete lease owns execution; copied leases cannot reuse an admitted job. */
export function ciExecutionDigest(lease: Lease): string {
	return hash([
		"hobo.ci.execution/v1",
		ciReservationId(lease),
		required(lease.id),
		ciFinancialPlanHash(lease),
	]);
}
function identity(lease: Lease): BudgetIdentity {
	return create(BudgetIdentitySchema, {
		tenantId: required(lease.budgetTenantId),
		budgetId: required(lease.budgetId),
		periodId: required(lease.budgetPeriodId),
		policyRevision: required(lease.budgetPolicyRevision),
	});
}
function checkedPolicy(
	lease: Lease,
	options: CiSharedBudgetOptions,
	at: string,
) {
	const policy = parseBudgetPolicyJson(lease.budgetPolicyDigest);
	if (
		canonicalBudgetPolicyJson(policy) !== lease.budgetPolicyDigest ||
		policy.tenantId !== lease.budgetTenantId ||
		policy.budgetId !== lease.budgetId ||
		policy.periodId !== lease.budgetPeriodId ||
		String(policy.revision) !== lease.budgetPolicyRevision ||
		!policy.workloads.includes("ci") ||
		(options.mode !== undefined && options.mode !== policy.enforcement) ||
		(policy.periodKind === "fixed-window" &&
			(policy.periodStartsAtMs === undefined ||
				policy.periodEndsAtMs === undefined ||
				Date.parse(at) < policy.periodStartsAtMs ||
				Date.parse(at) >= policy.periodEndsAtMs))
	)
		throw new Error(
			"CI admission must preserve the complete pinned common budget policy",
		);
	return policy;
}
function checkedQuote(
	lease: Lease,
	options: CiSharedBudgetOptions,
	at: string,
	precommitDenial = false,
): HostingQuote {
	const policy = checkedPolicy(lease, options, at);
	const quote = create(HostingQuoteSchema, options.quoteLease(lease));
	validateHostingQuote(quote, at);
	if (
		quote.ownerTenantId !== lease.budgetTenantId ||
		quote.providerId !== lease.provider ||
		quote.yardId !== `ci:${lease.accountId}` ||
		quote.requestDigest !== ciRequestDigest(lease) ||
		quote.financialPlanHash !== ciFinancialPlanHash(lease) ||
		quote.totalMicros !== lease.reservedPaidMicros ||
		quote.providerAccounts.length !== 1 ||
		quote.providerAccounts[0]?.providerAccountId !== lease.providerAccountId ||
		quote.providerAccounts[0]?.liabilityMicros !== quote.liabilityBoundMicros ||
		(lease.reservedFreeMinutes > 0 && quote.entitlementClaims.length === 0)
	)
		throw new Error(
			"CI quote must bind the complete original payer, duration, price and credit claims",
		);
	if (quote.liabilityBoundMicros !== lease.reservedPaidMicros) {
		const message =
			"native liability must equal the complete CI reservation; refresh the authoritative rate card";
		if (precommitDenial)
			throw new BudgetAdmissionDeniedError("policy.denied", message);
		throw new Error(message);
	}
	if (
		policy.enforcement === "strict" &&
		options.verifyProviderLiabilityBound?.(lease, quote, at) !== true
	)
		throw new Error(
			"strict CI admission requires a trustworthy provider liability bound",
		);
	return quote;
}
function checkedClaimQuote(
	lease: Lease,
	reservation: BudgetReservation,
	options: CiSharedBudgetOptions,
	at: string,
): HostingQuote {
	const quote = checkedQuote(lease, options, at);
	const digest = createHash("sha256")
		.update(toJsonString(HostingQuoteSchema, quote))
		.digest("hex");
	if (digest !== reservation.quoteDigest)
		throw new Error("CI launch quote differs from the pinned admission");
	return quote;
}
function checkedAllocation(
	lease: Lease,
	quote: HostingQuote,
	ledger: BudgetLedgerSnapshot,
	options: CiSharedBudgetOptions,
): void {
	const allowance = lease.sandboxReservedAllowance;
	const nativeUnits = allowance
		? [
				allowance.cpuVcpuMs,
				allowance.memoryMbMs,
				allowance.egressBytes,
				allowance.creations,
				allowance.proxyBytes,
				allowance.proxySessions,
				allowance.proxyControlCalls,
			].map((value) => integer(value))
		: [];
	if (
		(quantity(lease.reservedFreeMinutes) > 0 ||
			nativeUnits.some((value) => value > 0)) &&
		options.verifyAllocationCoverage?.(lease, quote, ledger) !== true
	)
		throw new Error(
			"complete native allocation coverage and scoped unit proof required",
		);
	for (const claim of quote.entitlementClaims) {
		if (
			!ledger.entitlements.some(
				(bucket) =>
					bucket.bucketId === claim.bucketId &&
					bucket.unit === claim.unit &&
					bucket.periodId === lease.budgetPeriodId,
			)
		)
			throw new Error(
				"CI allocation claim must bind an original parent bucket and unit",
			);
	}
}
function checkedFinancialPolicy(
	lease: Lease,
	quote: HostingQuote,
	ledger: BudgetLedgerSnapshot,
	existing: BudgetReservation | undefined,
	options: CiSharedBudgetOptions,
	at: string,
	measurements: CiPolicyMeasurements = [],
	precommitDenial = false,
): void {
	const policy = checkedPolicy(lease, options, at);
	if (ledger.limitMicros !== policy.limitMicros)
		throw new Error("CI policy limit differs from shared financial authority");
	if (!ledger.identity || quote.liabilityBoundMicros === undefined)
		throw new Error("complete parent financial context required");
	const own =
		existing && ["held", "uncertain"].includes(existing.status)
			? checkedReservation(lease, existing)
			: undefined;
	const sum = (...values: number[]) =>
		integer(values.reduce((total, value) => total + integer(value), 0));
	const without = (total: number, excluded: number) =>
		integer(integer(total) - integer(excluded));
	if (
		measurements.some(
			(measurement) =>
				measurement.key === "work.cost" || measurement.key === "provider.cost",
		)
	)
		throw new Error(
			"CI callers cannot supply quote-derived financial measurements",
		);
	const duration =
		quantity(lease.reservedMinutes) * 60000 +
		(lease.sandboxPricing?.proxyVmRequired
			? lease.sandboxPricing.proxyVmExtraMs
			: 0);
	integer(duration);
	const suppliedDuration = measurements.find(
		(measurement) => measurement.key === "work.duration" && !measurement.target,
	);
	if (
		suppliedDuration &&
		(suppliedDuration.unit !== "ms" || suppliedDuration.value < duration)
	)
		throw new Error("CI duration omits approved execution or proxy lifetime");
	const providerMeasurements = ledger.providerAccounts.map((account) => ({
		key: "provider.cost",
		unit: "USD.micros",
		target: account.providerAccountId,
		value: sum(
			account.spentMicros,
			without(
				account.reservedMicros,
				own?.providerAccounts.find(
					(row) => row.providerAccountId === account.providerAccountId,
				)?.liabilityMicros ?? 0,
			),
			account.externalCommittedMicros,
			quote.providerAccounts.find(
				(row) => row.providerAccountId === account.providerAccountId,
			)?.liabilityMicros ?? 0,
		),
	}));
	const verdict = evaluateBudgetPolicy(policy, {
		workload: "ci",
		tenantId: ledger.identity.tenantId,
		budgetId: ledger.identity.budgetId,
		periodId: ledger.identity.periodId,
		policyRevision: ledger.identity.policyRevision,
		nowMs: Date.parse(at),
		costBoundMicros: quote.liabilityBoundMicros,
		exposureMicros: sum(
			ledger.spentMicros,
			without(ledger.reservedMicros, own?.reservedMicros ?? 0),
			ledger.unresolvedMicros,
			ledger.recoveryReserveMicros,
			ledger.externalCommittedMicros,
		),
		boundKind: policy.enforcement === "strict" ? "native" : "conservative",
		phase: "admit",
		measurements: [
			...measurements,
			...(suppliedDuration
				? []
				: [{ key: "work.duration", unit: "ms", value: duration }]),
			...providerMeasurements,
		],
	});
	if (!verdict.ok) {
		const message = `${verdict.code}: ${verdict.reason}`;
		if (
			precommitDenial &&
			["budget.policy.exhausted", "budget.policy.constraint"].includes(
				verdict.code,
			)
		)
			throw new BudgetAdmissionDeniedError(
				verdict.code === "budget.policy.constraint"
					? "policy.denied"
					: "budget.exhausted",
				message,
			);
		throw new Error(message);
	}
}
function checkedReservation(
	lease: Lease,
	reservation: BudgetReservation | undefined,
): BudgetReservation {
	if (
		!reservation ||
		reservation.reservationId !== ciReservationId(lease) ||
		reservation.requestDigest !== ciRequestDigest(lease) ||
		reservation.financialPlanHash !== ciFinancialPlanHash(lease) ||
		!reservation.identity ||
		toJsonString(BudgetIdentitySchema, reservation.identity) !==
			toJsonString(BudgetIdentitySchema, identity(lease))
	)
		throw new Error("exact original CI financial reservation required");
	return reservation;
}
function checkedUsage(
	lease: Lease,
	reservation: BudgetReservation,
	evidence: BudgetSettlementEvidence,
	options: CiSharedBudgetOptions,
): void {
	if (
		!reservation.executionDigest ||
		reservation.executionDigest !== ciExecutionDigest(lease) ||
		!evidence.usageEvidenceRef ||
		!evidence.sourceStoppedEvidenceRef ||
		options.verifyFinalUsage?.(lease, evidence) !== true
	)
		throw new Error(
			"native final usage and source retirement proof required for this CI execution",
		);
	integer(lease.paidMicros);
}
function checkedUnused(
	lease: Lease,
	reservation: BudgetReservation,
	evidenceRef: string,
	options: CiSharedBudgetOptions,
): void {
	if (
		reservation.executionDigest ||
		lease.state !== "cancelled" ||
		!evidenceRef ||
		options.verifyUnused?.(lease, evidenceRef) !== true
	)
		throw new Error("durable cancelled-before-claim CAS evidence required");
}

/** Uses the SAME authority as hosting. The caller reserves before its lease transaction commits.
 * Unknown cross-database outcomes keep the parent hold; reconciliation never releases by absence. */
export function createCiSharedBudgetHooks(
	options: CiSharedBudgetOptions & { authority: BudgetAdmissionAuthority },
): CiSharedBudgetHooks {
	const { authority } = options;
	if (
		options.mode !== undefined &&
		options.mode !== "strict" &&
		options.mode !== "conservative"
	)
		throw new Error("unsupported CI admission mode");
	if (authority.persistence !== "durable-cas")
		throw new Error("CI shared admission requires a durable parent authority");
	const now = options.now ?? (() => new Date().toISOString());
	const lookup = (lease: Lease) =>
		checkedReservation(lease, authority.lookup(ciReservationId(lease)));
	const financialState = (lease: Lease, at: string) => {
		const before = authority.read(at);
		const existing = authority.lookup(ciReservationId(lease));
		const ledger = authority.read(at);
		if (before.seq !== ledger.seq)
			throw new Error(
				"budget sequence conflict while reading CI financial context",
			);
		return { ledger, existing };
	};
	return {
		reserve(lease, measurements) {
			const at = now();
			const quote = checkedQuote(lease, options, at, true);
			const { ledger: current, existing } = financialState(lease, at);
			checkedAllocation(lease, quote, current, options);
			checkedFinancialPolicy(
				lease,
				quote,
				current,
				existing,
				options,
				at,
				measurements,
				true,
			);
			return authority.reserve({
				reservationId: ciReservationId(lease),
				requestDigest: ciRequestDigest(lease),
				quote,
				identity: identity(lease),
				expectedSeq: current.seq,
				now: at,
			});
		},
		claim(lease, measurements) {
			const at = now();
			const quote = checkedClaimQuote(lease, lookup(lease), options, at);
			const { ledger: current, existing } = financialState(lease, at);
			checkedAllocation(lease, quote, current, options);
			checkedFinancialPolicy(
				lease,
				quote,
				current,
				existing,
				options,
				at,
				measurements,
			);
			const claimed = authority.claimExecution({
				reservationId: ciReservationId(lease),
				requestDigest: ciRequestDigest(lease),
				executionDigest: ciExecutionDigest(lease),
				expectedSeq: current.seq,
			});
			// Financial storage may have waited for a lock. Permission is current at return.
			checkedClaimQuote(
				lease,
				checkedReservation(lease, claimed),
				options,
				now(),
			);
			return claimed;
		},
		uncertain(lease) {
			return authority.uncertain(lookup(lease).reservationId);
		},
		settle(lease, evidence) {
			const reservation = lookup(lease);
			checkedUsage(lease, reservation, evidence, options);
			return authority.settle(
				reservation.reservationId,
				lease.paidMicros,
				evidence,
			);
		},
		releaseUnused(lease, evidenceRef) {
			const reservation = lookup(lease);
			checkedUnused(lease, reservation, evidenceRef, options);
			return authority.release(reservation.reservationId, true, evidenceRef);
		},
	};
}

/** Distributed hosts use an asynchronous, shared transactional parent, never host-local SQLite. */
export function createCiAsyncSharedBudgetHooks(
	options: CiSharedBudgetOptions & { authority: AsyncBudgetAdmissionAuthority },
): CiAsyncSharedBudgetHooks {
	const { authority } = options;
	if (
		options.mode !== undefined &&
		options.mode !== "strict" &&
		options.mode !== "conservative"
	)
		throw new Error("unsupported CI admission mode");
	if (authority.persistence !== "durable-cas")
		throw new Error("CI shared admission requires a durable parent authority");
	const now = options.now ?? (() => new Date().toISOString());
	const lookup = async (lease: Lease) =>
		checkedReservation(lease, await authority.lookup(ciReservationId(lease)));
	const financialState = async (lease: Lease, at: string) => {
		const before = await authority.read(at);
		const existing = await authority.lookup(ciReservationId(lease));
		const ledger = await authority.read(at);
		if (before.seq !== ledger.seq)
			throw new Error(
				"budget sequence conflict while reading CI financial context",
			);
		return { ledger, existing };
	};
	return {
		async reserve(lease, measurements) {
			const at = now();
			const quote = checkedQuote(lease, options, at, true);
			const { ledger: current, existing } = await financialState(lease, at);
			checkedAllocation(lease, quote, current, options);
			checkedFinancialPolicy(
				lease,
				quote,
				current,
				existing,
				options,
				at,
				measurements,
				true,
			);
			return authority.reserve({
				reservationId: ciReservationId(lease),
				requestDigest: ciRequestDigest(lease),
				quote,
				identity: identity(lease),
				expectedSeq: current.seq,
				now: at,
			});
		},
		async claim(lease, measurements) {
			const at = now();
			const quote = checkedClaimQuote(lease, await lookup(lease), options, at);
			const { ledger: current, existing } = await financialState(lease, at);
			checkedAllocation(lease, quote, current, options);
			checkedFinancialPolicy(
				lease,
				quote,
				current,
				existing,
				options,
				at,
				measurements,
			);
			const claimed = await authority.claimExecution({
				reservationId: ciReservationId(lease),
				requestDigest: ciRequestDigest(lease),
				executionDigest: ciExecutionDigest(lease),
				expectedSeq: current.seq,
			});
			checkedClaimQuote(
				lease,
				checkedReservation(lease, claimed),
				options,
				now(),
			);
			return claimed;
		},
		async uncertain(lease) {
			return authority.uncertain((await lookup(lease)).reservationId);
		},
		async settle(lease, evidence) {
			const reservation = await lookup(lease);
			checkedUsage(lease, reservation, evidence, options);
			return authority.settle(
				reservation.reservationId,
				lease.paidMicros,
				evidence,
			);
		},
		async releaseUnused(lease, evidenceRef) {
			const reservation = await lookup(lease);
			checkedUnused(lease, reservation, evidenceRef, options);
			return authority.release(reservation.reservationId, true, evidenceRef);
		},
	};
}
