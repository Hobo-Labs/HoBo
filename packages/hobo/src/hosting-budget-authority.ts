import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type AsyncBudgetAdmissionAuthority,
	type BudgetAdmissionAuthority,
	BudgetIdentitySchema,
	type BudgetLedgerSnapshot,
	type BudgetReservation,
	type BudgetSettlementEvidence,
	EntitlementClaimSchema,
	HostingQuoteComponentSchema,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "@hobo/broker";
import {
	canonicalHostingEvidence,
	createHostingPlanningPass,
	type HostingEntitlement,
	type HostingPlanCommitment,
	type HostingPlanningInput,
	type HostingReservationIdentity,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";

/** Trusted adapter wiring: these callbacks read server-owned evidence, never
 * return the caller's proposal unchanged without independently verifying it. */
export function createHostingBudgetAuthorityBridge(options: {
	authority: BudgetAdmissionAuthority | AsyncBudgetAdmissionAuthority;
	scopeId: string;
	nowMs: () => number;
	resolve: NonNullable<SharedHostingBudgetAuthority["resolve"]>;
	revalidate: (request: {
		planHash: string;
		commitment: HostingPlanCommitment;
	}) => Promise<HostingPlanningInput>;
	settlement: (
		request: HostingReservationIdentity & {
			settledMicros: number;
			evidenceRef: string;
			sourceStoppedEvidenceRef: string;
		},
	) => Promise<BudgetSettlementEvidence & { actualMicros: number }>;
}): SharedHostingBudgetAuthority {
	if (options.authority.persistence !== "durable-cas" || !options.scopeId)
		throw new Error(
			"hosting requires an authoritative durable-CAS budget and bound scope",
		);
	const authority = options.authority;
	const now = () => {
		const value = options.nowMs();
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("invalid trusted hosting clock");
		return value;
	};
	const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
	const integer = (value: number) => {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error(
				"hosting financial quantities must be safe nonnegative integers",
			);
		return value;
	};
	const sum = (...values: number[]) =>
		integer(values.reduce((total, value) => total + integer(value), 0));
	function digest(planHash: string, commitmentHash: string): string {
		if (
			!/^sha256:[a-f0-9]{64}$/.test(planHash) ||
			!/^sha256:[a-f0-9]{64}$/.test(commitmentHash)
		)
			throw new Error(
				"content-addressed hosting plan and financial commitment required",
			);
		return `sha256:${createHash("sha256").update(canonicalHostingEvidence({ planHash, commitmentHash })).digest("hex")}`;
	}
	function scaleFor(
		entitlement: HostingEntitlement,
		input: HostingPlanningInput,
	) {
		const durations = new Map([
			["time-ms", 1],
			["second", 1000],
			["minute", 60_000],
			["hour", 3_600_000],
			["day", 86_400_000],
		]);
		if (entitlement.unit === "month") {
			const periods = [
				...new Set(
					input.quotes
						.filter((quote) => quote.entitlementId === entitlement.id)
						.map((quote) => quote.billingPeriodMs),
				),
			];
			const period = periods[0];
			if (
				periods.length !== 1 ||
				period === undefined ||
				!Number.isSafeInteger(period) ||
				period <= 0
			)
				throw new Error(
					"calendar entitlement requires one exact billing duration",
				);
			return { unit: "time-ms", scale: period };
		}
		const duration = durations.get(entitlement.unit);
		return duration !== undefined
			? { unit: "time-ms", scale: duration }
			: { unit: entitlement.unit, scale: 1 };
	}
	function baseUnits(value: number, scale: number): number {
		if (!Number.isFinite(value) || value < 0)
			throw new Error("invalid entitlement quantity");
		const [mantissa = "0", exponentText] = String(value)
				.toLowerCase()
				.split("e"),
			[whole = "0", decimals = ""] = mantissa.split(".");
		const exponent = Number(exponentText ?? 0) - decimals.length;
		let numerator = BigInt(whole + decimals) * BigInt(integer(scale)),
			denominator = 1n;
		if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
		else denominator = 10n ** BigInt(-exponent);
		if (
			numerator % denominator !== 0n ||
			numerator / denominator > BigInt(Number.MAX_SAFE_INTEGER)
		)
			throw new Error(
				"entitlement cannot be represented exactly in base units",
			);
		return Number(numerator / denominator);
	}
	function check(
		input: HostingPlanningInput,
		snapshot: BudgetLedgerSnapshot,
		at: number,
	): void {
		const budget = input.budget,
			identity = snapshot.identity;
		if (
			!identity ||
			budget.tenantId !== identity.tenantId ||
			budget.budgetId !== identity.budgetId ||
			budget.periodId !== identity.periodId ||
			budget.policyRevision !== identity.policyRevision ||
			budget.scopeId !== options.scopeId ||
			budget.currency !== "USD"
		)
			throw new Error(
				"hosting budget scope, period, currency or policy changed",
			);
		if (
			budget.ledgerSeq !== snapshot.seq ||
			budget.capMicros !== snapshot.limitMicros ||
			budget.settledMicros !== snapshot.spentMicros ||
			budget.committedMicros !==
				sum(snapshot.externalCommittedMicros, snapshot.reservedMicros) ||
			budget.unresolvedMicros !== snapshot.unresolvedMicros ||
			budget.recoveryReserveMicros !== snapshot.recoveryReserveMicros
		)
			throw new Error(
				"hosting budget evidence differs from authoritative exposure",
			);
		if (
			input.nowMs > at ||
			input.horizonEndMs <= at ||
			budget.validUntilMs <= at ||
			budget.validUntilMs > Date.parse(snapshot.validUntil) ||
			Date.parse(snapshot.observedAt) > at
		)
			throw new Error("hosting financial evidence is no longer current");
		if (snapshot.providerAccounts.length !== input.providerBudgets.length)
			throw new Error("complete provider-account ceilings must be bound");
		for (const account of snapshot.providerAccounts) {
			const pinned = input.providerBudgets.find(
				(row) => row.providerAccountId === account.providerAccountId,
			);
			if (
				!pinned ||
				pinned.tenantId !== budget.tenantId ||
				pinned.currency !== budget.currency ||
				pinned.capMicros !== account.limitMicros ||
				pinned.settledMicros !== account.spentMicros ||
				pinned.committedMicros !==
					sum(account.externalCommittedMicros, account.reservedMicros) ||
				pinned.unresolvedMicros !== 0 ||
				pinned.recoveryReserveMicros !== 0
			)
				throw new Error(
					"provider-account exposure changed or has unsupported offsets",
				);
		}
		for (const entitlement of input.entitlements) {
			const normalized = scaleFor(entitlement, input),
				bucket = snapshot.entitlements.find(
					(row) => row.bucketId === entitlement.id,
				);
			if (
				!bucket ||
				bucket.unit !== normalized.unit ||
				bucket.periodId !== budget.periodId ||
				baseUnits(entitlement.remainingQuantity, normalized.scale) !==
					bucket.remainingUnits - bucket.reservedUnits ||
				entitlement.validUntilMs > Date.parse(bucket.validUntil) ||
				entitlement.validUntilMs <= at ||
				Date.parse(bucket.observedAt) > at
			)
				throw new Error(
					"entitlement exposure changed, expired or belongs to another period",
				);
		}
		for (const quote of input.quotes)
			if (
				quote.observedAtMs > at ||
				at - quote.observedAtMs > input.maxObservationAgeMs ||
				quote.validUntilMs <= at
			)
				throw new Error("hosting quote has expired or is no longer fresh");
		if (at - budget.observedAtMs > input.maxObservationAgeMs)
			throw new Error("hosting snapshot is no longer fresh");
	}
	function recompute(commitment: HostingPlanCommitment): HostingPlanCommitment {
		if (
			!commitment.evidence ||
			commitment.scopeId !== options.scopeId ||
			commitment.budgetId !== commitment.evidence.budget.budgetId ||
			commitment.tenantId !== commitment.evidence.budget.tenantId
		)
			throw new Error(
				"complete pinned hosting evidence and matching scope required",
			);
		const pass = createHostingPlanningPass(commitment.evidence);
		const resources = new Set(
			commitment.evidence.usages.map((usage) => usage.resourceName),
		);
		const committedResources = new Set(
			commitment.allocations.map((allocation) => allocation.resourceName),
		);
		if (
			resources.size === 0 ||
			commitment.allocations.length !== committedResources.size ||
			resources.size !== committedResources.size ||
			[...resources].some((resource) => !committedResources.has(resource))
		)
			throw new Error(
				"financial commitment must cover every resource in the trusted usage evidence exactly once",
			);
		for (const allocation of commitment.allocations) {
			const quote = commitment.evidence.quotes.find(
				(row) =>
					row.id === allocation.quoteId &&
					row.resourceName === allocation.resourceName &&
					row.definitionId === allocation.definitionId,
			);
			if (!quote) throw new Error("commitment names an unknown quote");
			pass.commit(allocation.resourceName, {
				id: allocation.definitionId,
				providerId: quote.providerId,
				port: "hosting",
				features: [],
				regions: [],
				specificity: 0,
				priority: 0,
				cost: {
					sku: allocation.definitionId,
					unit: quote.billingUnit,
					marginalPrice: "0",
				},
				satisfies: () => ({ kind: "full" }),
			});
		}
		const calculated = pass.commitment();
		if (
			canonicalHostingEvidence(calculated) !==
			canonicalHostingEvidence(commitment)
		)
			throw new Error(
				"hosting proposal or commitment digest was tampered with",
			);
		return calculated;
	}
	function checkAuthorization(
		commitment: HostingPlanCommitment,
		at: number,
	): void {
		if (
			commitment.validUntilMs <= at ||
			commitment.evidence.horizonEndMs <= at ||
			commitment.evidence.quotes.some(
				(quote) =>
					quote.validUntilMs <= at ||
					at - quote.observedAtMs > commitment.evidence.maxObservationAgeMs,
			)
		)
			throw new Error(
				"hosting authorization expired; re-plan before execution",
			);
	}
	async function reservation(
		request: HostingReservationIdentity,
	): Promise<BudgetReservation | undefined> {
		const row = await authority.lookup(request.reservationId);
		if (
			row &&
			(row.identity?.tenantId !== request.tenantId ||
				row.quoteId !== request.commitmentHash)
		)
			throw new Error(
				"reservation belongs to a different tenant or financial commitment",
			);
		return row;
	}
	return {
		persistence: "durable-cas",
		async resolve(request) {
			const input = await options.resolve(request);
			if (
				input.budget.tenantId !== request.tenantId ||
				input.budget.budgetId !== request.budgetId
			)
				throw new Error("trusted resolver returned a foreign budget");
			const snapshot = await authority.read(iso(now()));
			check(input, snapshot, now());
			return input;
		},
		async reserve(request) {
			try {
				const commitment = recompute(request.commitment),
					requestDigest = digest(request.planHash, commitment.commitmentHash);
				checkAuthorization(commitment, now());
				const previous = await reservation({
					reservationId: request.reservationId,
					tenantId: commitment.tenantId,
					commitmentHash: commitment.commitmentHash,
				});
				let current = await authority.read(iso(now()));
				let at = now();
				checkAuthorization(commitment, at);
				if (previous) {
					if (
						previous.requestDigest !== requestDigest ||
						previous.identity?.policyRevision !==
							current.identity?.policyRevision ||
						previous.identity?.periodId !== current.identity?.periodId ||
						previous.status !== "held"
					)
						throw new Error(
							"reservation is uncertain, terminal or superseded; reconcile before execution",
						);
					return { ok: true, reservationId: previous.reservationId };
				}
				const trusted = await options.revalidate({
					planHash: request.planHash,
					commitment,
				});
				current = await authority.read(iso(now()));
				at = now();
				checkAuthorization(commitment, at);
				if (
					canonicalHostingEvidence(
						createHostingPlanningPass({
							...trusted,
							nowMs: commitment.evidence.nowMs,
						}).commitment().evidence,
					) !== canonicalHostingEvidence(commitment.evidence)
				)
					throw new Error(
						"trusted planning evidence changed; re-plan before admission",
					);
				check(commitment.evidence, current, at);
				const providers = new Map<string, number>(),
					claims = new Map<string, number>();
				for (const allocation of commitment.allocations) {
					if (!allocation.providerCharges?.length)
						throw new Error(
							"complete source and destination payer attribution required",
						);
					for (const charge of allocation.providerCharges)
						providers.set(
							charge.providerAccountId,
							sum(
								providers.get(charge.providerAccountId) ?? 0,
								charge.reservedMicros,
							),
						);
					for (const claim of allocation.entitlementClaims ?? []) {
						const entitlement = commitment.evidence.entitlements.find(
							(row) => row.id === claim.entitlementId,
						);
						if (!entitlement || entitlement.unit !== claim.unit)
							throw new Error("missing held entitlement or mismatched unit");
						const scale = scaleFor(entitlement, commitment.evidence);
						claims.set(
							entitlement.id,
							sum(
								claims.get(entitlement.id) ?? 0,
								baseUnits(claim.quantity, scale.scale),
							),
						);
					}
				}
				const quote = create(HostingQuoteSchema, {
					quoteId: commitment.commitmentHash,
					yardId: options.scopeId,
					providerId: "hosting-plan",
					ownerTenantId: commitment.tenantId,
					currency: commitment.currency,
					totalMicros: commitment.expectedMicros,
					liabilityBoundMicros: commitment.reservedMicros,
					requestDigest,
					financialPlanHash: request.planHash,
					observedAt: iso(commitment.evidence.nowMs),
					validUntil: iso(
						Math.min(commitment.validUntilMs, commitment.evidence.horizonEndMs),
					),
					components: commitment.allocations.map((allocation) =>
						create(HostingQuoteComponentSchema, {
							name: allocation.resourceName,
							costMicros: allocation.expectedMicros,
						}),
					),
					providerAccounts: [...providers].map(
						([providerAccountId, liabilityMicros]) =>
							create(ProviderAccountExposureSchema, {
								providerAccountId,
								liabilityMicros,
							}),
					),
					entitlementClaims: [...claims].map(([bucketId, units]) => {
						const entitlement = commitment.evidence.entitlements.find(
							(row) => row.id === bucketId,
						);
						if (!entitlement) throw new Error("missing financial scope");
						return create(EntitlementClaimSchema, {
							bucketId,
							unit: scaleFor(entitlement, commitment.evidence).unit,
							units,
						});
					}),
				});
				await authority.reserve({
					reservationId: request.reservationId,
					requestDigest,
					quote,
					identity: create(BudgetIdentitySchema, {
						tenantId: commitment.tenantId,
						budgetId: commitment.budgetId,
						periodId: commitment.periodId,
						policyRevision: commitment.policyRevision,
					}),
					expectedSeq: commitment.ledgerSeq,
					now: iso(at),
				});
				// A slow transaction may commit a hold after the caller's execution window.
				// Keep that durable hold, but do not authorize activation after it expired.
				checkAuthorization(commitment, now());
				return { ok: true, reservationId: request.reservationId };
			} catch (error) {
				return {
					ok: false,
					reason:
						error instanceof Error
							? error.message
							: "hosting budget admission failed",
				};
			}
		},
		async lookup(request) {
			const row = await reservation(request);
			if (!row) return { status: "missing", reservedMicros: 0 };
			if (row.status === "released")
				return { status: "missing", reservedMicros: 0 };
			if (
				row.status !== "held" &&
				row.status !== "uncertain" &&
				row.status !== "settled"
			)
				throw new Error("unsupported reservation state");
			const view: Awaited<ReturnType<SharedHostingBudgetAuthority["lookup"]>> =
				{
					status: row.status,
					reservedMicros: row.reservedMicros,
					commitmentHash: row.quoteId,
					financialPlanHash: row.financialPlanHash,
				};
			if (row.executionDigest) view.executionDigest = row.executionDigest;
			if (row.status === "settled") view.settledMicros = row.actualMicros;
			return view;
		},
		async claimExecution(request) {
			try {
				const row = await reservation(request);
				if (!row || row.financialPlanHash !== request.financialPlanHash)
					throw new Error("financial authorization does not match execution");
				await authority.claimExecution({
					reservationId: request.reservationId,
					requestDigest: digest(
						request.financialPlanHash,
						request.commitmentHash,
					),
					executionDigest: request.executionDigest,
				});
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					reason:
						error instanceof Error
							? error.message
							: "execution authorization refused",
				};
			}
		},
		async uncertain(request) {
			const row = await reservation(request);
			if (!row) throw new Error("unknown hosting reservation");
			await authority.uncertain(row.reservationId);
		},
		async settle(request) {
			try {
				const row = await reservation(request);
				if (!row) throw new Error("unknown hosting reservation");
				const actual = await options.settlement(request);
				if (
					actual.usageEvidenceRef !== request.evidenceRef ||
					actual.sourceStoppedEvidenceRef !== request.sourceStoppedEvidenceRef
				)
					throw new Error(
						"authoritative settlement evidence does not match the observed references",
					);
				await authority.settle(
					row.reservationId,
					integer(actual.actualMicros),
					actual,
				);
				if (actual.actualMicros !== request.settledMicros)
					return {
						ok: false,
						reason:
							"authoritative actual charges were recorded; refresh the settlement observation",
					};
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					reason:
						error instanceof Error
							? error.message
							: "hosting settlement remains unresolved",
				};
			}
		},
	};
}
