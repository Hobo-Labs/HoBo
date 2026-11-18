export type AcceptanceScorecardRow = Readonly<{
	id: string;
	status: "pass";
	evidenceFile: string;
	evidenceTest: string;
}>;

export const PRICING_ACCEPTANCE_ROWS = Object.freeze(
	([
		[
			"§1.1",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.1 rates only usage beyond the existing 950/1000 minutes",
		],
		[
			"§1.2",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.1 rates only usage beyond the existing 950/1000 minutes",
		],
		[
			"§1.3",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.2 distinguishes paid-credit basis from promotional credit",
		],
		[
			"§1.4",
			"packages/pricing/test/section-13-invariants.test.ts",
			"denies new provider agreements unless explicitly allowed",
		],
		[
			"§1.5",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.8 rejects observations that do not cover the quote horizon",
		],
		[
			"§1.6",
			"packages/pricing/test/decimal-money.test.ts",
			"parseDecimal rejects non-canonical wire decimals",
		],
		[
			"§1.7",
			"packages/pricing/test/golden-replay.test.ts",
			"replays every pinned scenario to its exact quote and hash",
		],
		[
			"§1.8",
			"packages/pricing/test/section-13-invariants.test.ts",
			"excludes customer commerce concepts from provider pricing schemas",
		],
		[
			"§14.1",
			"packages/broker/test/pricing-authorization.test.ts",
			"prefers quote incremental over legacy spend estimate",
		],
		[
			"§14.2",
			"packages/pricing/test/section-13-invariants.test.ts",
			"legacy CI translators remain separate from CreditAccount fields",
		],
		[
			"§14.3",
			"packages/dispatcher/test/dispatcher-v2.test.ts",
			"ranks exact incremental billed decimals and removes advisory allocation",
		],
		[
			"§14.4",
			"packages/pricing/test/section-13-invariants.test.ts",
			"external persisted quotes never become executable rating",
		],
		[
			"§14.5",
			"packages/dispatcher/test/dispatcher-v2.test.ts",
			"fails closed instead of treating rejected pricing as zero",
		],
		[
			"§14.6",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.10 prices joint non-additive actions once instead of summing independent deltas",
		],
		[
			"§14.7",
			"packages/pricing/test/section-13-invariants.test.ts",
			"denies cancellation unless explicitly allowed",
		],
		[
			"§14.8",
			"packages/dispatcher/test/dispatcher-v2.test.ts",
			"ranks exact incremental billed decimals and removes advisory allocation",
		],
		[
			"§14.9",
			"packages/dispatcher/test/dispatcher-v1-byte-identical.test.ts",
			"keeps the complete fixed-fixture decision byte-identical",
		],
		[
			"§14.10",
			"packages/pricing/contracts/consumer/quote-boundary.test.ts",
			"meets the hand-authored QuoteVector expectation",
		],
		[
			"§13.decimal",
			"packages/pricing/test/decimal-money.test.ts",
			"parseDecimal rejects non-canonical wire decimals",
		],
		[
			"§13.rounding",
			"packages/pricing/test/section-13-coverage.test.ts",
			"§13 package rounding uses ceiling on package charges",
		],
		[
			"§13.fixed-recurring",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.1 rates only usage beyond the existing 950/1000 minutes",
		],
		[
			"§13.allowances",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.7 enforces a free plan hard limit without billing overage",
		],
		[
			"§13.credits",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.2 distinguishes paid-credit basis from promotional credit",
		],
		[
			"§13.commitments",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.3 consumes a $100 commitment with $40 used and $30 candidate",
		],
		[
			"§13.allocation",
			"packages/pricing/test/section-13-coverage.test.ts",
			"§13 allocation exposes advisory allocatedEffective separate from incremental effective",
		],
		[
			"§13.baselines",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.10 prices joint non-additive actions once instead of summing independent deltas",
		],
		[
			"§13.multidimensional",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.5 rates a multidimensional sandbox composite independently",
		],
		[
			"§13.migration",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.6 rates migration source removal and target addition jointly",
		],
		[
			"§13.freshness",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.8 rejects observations that do not cover the quote horizon",
		],
		[
			"§13.currency",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.9 refuses to rank or sum mixed currencies",
		],
		[
			"§13.reservations",
			"packages/dispatcher/test/reservation-ledger.test.ts",
			"restores exactly the headroom the reservation consumed",
		],
		[
			"§13.replay",
			"packages/dispatcher/test/dispatcher-v1-byte-identical.test.ts",
			"keeps the complete fixed-fixture decision byte-identical",
		],
		[
			"§13.governance",
			"packages/pricing/test/section-13-invariants.test.ts",
			"denies new provider agreements unless explicitly allowed",
		],
		[
			"§13.tenancy",
			"packages/pricing/test/state-tenancy.test.ts",
			"rejects agreements whose tenantId differs from financial state",
		],
		[
			"§13.security",
			"packages/broker/test/pricing-authorization.test.ts",
			"rejects negative quote incremental decimal",
		],
		[
			"§13.reconciliation",
			"packages/pricing/test/section-13-coverage.test.ts",
			"§13 reconciliation dedupes provider ids via billing sync",
		],
		[
			"§10.1",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.1 rates only usage beyond the existing 950/1000 minutes",
		],
		[
			"§10.2",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.2 distinguishes paid-credit basis from promotional credit",
		],
		[
			"§10.3",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.3 consumes a $100 commitment with $40 used and $30 candidate",
		],
		[
			"§10.4",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.4 keeps graduated and volume tiers distinct for 90 + 20 units",
		],
		[
			"§10.5",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.5 rates a multidimensional sandbox composite independently",
		],
		[
			"§10.6",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.6 rates migration source removal and target addition jointly",
		],
		[
			"§10.7",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.7 enforces a free plan hard limit without billing overage",
		],
		[
			"§10.8",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.8 rejects observations that do not cover the quote horizon",
		],
		[
			"§10.9",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.9 refuses to rank or sum mixed currencies",
		],
		[
			"§10.10",
			"packages/pricing/test/adversarial-10.test.ts",
			"10.10 prices joint non-additive actions once instead of summing independent deltas",
		],
		[
			"§10.11",
			"packages/dispatcher/test/dispatcher-v2-tiebreak.test.ts",
			"10.11 prefers sooner projected waste expiry among zero incremental ties",
		],
		[
			"§12.0",
			"packages/pricing/test/section-13-invariants.test.ts",
			"keeps provider-price rating deterministic and offline",
		],
		[
			"§12.1",
			"packages/pricing/test/golden-replay.test.ts",
			"replays every pinned scenario to its exact quote and hash",
		],
		[
			"§12.2",
			"packages/pricing/contracts/consumer/quote-boundary.test.ts",
			"meets the hand-authored QuoteVector expectation",
		],
		[
			"§12.3",
			"packages/dispatcher/test/dispatcher-v1-byte-identical.test.ts",
			"keeps the complete fixed-fixture decision byte-identical",
		],
		[
			"§12.4",
			"packages/broker/test/pricing-authorization.test.ts",
			"prefers quote incremental over legacy spend estimate",
		],
		[
			"§12.5",
			"packages/pricing/test/billing-sync.test.ts",
			"§12 Phase 5 live billing sync produces dated snapshot and variance against quote",
		],
	] as const).map(([id, evidenceFile, evidenceTest]) => ({
		id,
		status: "pass" as const,
		evidenceFile,
		evidenceTest,
	})),
) satisfies readonly AcceptanceScorecardRow[];
