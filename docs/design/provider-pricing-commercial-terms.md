# HoBo Provider Pricing And Commercial Terms

> **Status:** Batch 1 contract and rating kernel (ADR-0176). Later batches cover legacy translation, dispatcher v2, reservations, and provider integrations.

## Purpose

`@hobo/pricing` models what **providers** charge and produces deterministic, auditable quotes. Out of scope: customer billing, payments, tax, invoices (provider COGS / FinOps / routing only).

## Core entities

### ProviderProduct

Catalog product with **MeterDefinition** entries:

- `dimension`, `unit`
- aggregation: `sum` | `max` | `latest` | `unique-count`
- rounding: scope `event` | `period`, `multiple`, mode `ceil` | `floor` | `half-up`

### RateCard (immutable)

- New `id` per semantic change; `version`, `currency`, effective interval
- **ChargeComponent**:
  - **FixedCharge**: cadence `once|daily|weekly|monthly|yearly`, timing `advance|arrears`, amount, optional `quantityDimension`, proration `none|calendar-day|exact-second`
  - **UsageCharge**: dimension, timing, price = `per-unit` | `package(packageSize, packageAmount, rounding)` | `graduated(tiers)` | `volume(tiers)`
- **Tier**: `from` inclusive, `to` exclusive optional, `flatAmount`, `unitAmount`
- **ChargeBase**: `id`, match selectors (exact), `exclusiveGroup`, `fallback`, `invoiceBehavior`
- **Exclusive groups**: exactly one matching non-fallback, else one fallback, else **fail closed**

### ProviderAgreement

`tenantId`, `providerAccountRef` (never a credential), `productId`, `rateSchedule[{rateCardId, effective}]`, status `trialing|active|past-due|suspended|cancelled`, term, `billingPeriod{interval, anchor, timeZone UTC v1}`, quantities, cancellation `{allowed, refund none|prorated|full, fee, notice}`, evidence.

### Grants

**GrantScope**: `{productIds, rateCardIds, chargeIds, dimensions}`

- **AllowanceGrant**: included quantity, `derivedFrom`, recurrence, effective, rollover `{max, reset}`, exhaustion `bill-overage|block-usage`, priority, evidence
- **CreditGrant**: category `paid|promotional|support-adjustment`, faceValue `Money|Quantity`, economicBasis `zero|acquisition(amount)|face-value`, derivedFrom, effective, recurrence, rollover, priority
- **Commitment**: kind `spend|usage`, amount, bucketGranularity `hour|day|month|billing-period|term`, term, payment `upfront|recurring|mixed`, underuse `forfeit|rollover|true-up`, amortization `straight-line|provider-actual`

Derived grants: zero extra basis (CUE rejects otherwise). Purchased partially-consumed credits allocate basis pro rata. Commitments consumed at declared bucket granularity or fail closed.

### FinancialStateView

`view`, schema `hobo.pricing/v1`, `tenantId`, `seq`, `stateHash`, `asOf`, agreements, allowances (remaining), credits (remaining), commitments (used/unused), periodActuals **ActualCharge** (FOCUS-shaped billed/effective/list/contracted cost, category usage|purchase|credit|adjustment|tax, commitmentStatus), completeness `complete|partial`, observations.

Partial/stale data never auto-routes; missing ≠ zero; never fall back to `listUnitCost`; structured `rejectedCandidates` reasons.

### QuoteScenario

`action` place|dispatch|rebalance|migrate|cancel, `at`, `horizon`, `pricingCatalogHash`, `state`, `baseline[]`, `candidate[]` **WorkloadDelta** `{productRef, agreementRef, direction add|remove, quantities, usage UsageMeasurement[], attributes}`, `sourceProviderAgreementIds`, options `{allowNewProviderAgreement=false, allowCancellation=false, amortization, allocationConvention marginal-consume|period-proportional, allocationForecast}`.

### QuoteVector

Schema `hobo.pricing.quote/v1`: `ratingAlgorithmVersion`, hashes, baseline/candidate/incremental **Billed**, **dueNow**, baseline/candidate/incremental **Effective**, `allocationConvention`, `allocatedEffective` (advisory only), `nominalAtListRate`, `newObligations`, `migrationAndTermination`, lines, consumption, remainingHeadroom, projectedWaste, assumptions, unpriced, eligibility.

## Normative rules

- Quote deltas: **F(baseline + candidate) − F(baseline)**
- Exact decimal strings on wire; scaled-integer math; **no floats**
- Explicit unit conversions (GB vs GiB never inferred)
- Evidence valid through whole horizon
- Fail closed: unknown/stale/unsupported/ambiguous/cross-currency
- No live provider calls in decision/replay — **ExternalProviderQuote** persisted only, else `PRICING_MODEL_UNSUPPORTED`
- New agreements/cancellations default-deny
- Negative volume deltas never create budget headroom
- Basis conservation invariants
- Credits sorted: priority, earliest expiry, grant ID
- No wall clock/network/env/locale/unordered iteration in quotes

## Rating algorithm (12 steps)

1. Validate scenario + state completeness for action/horizon (fail closed).
2. Pin catalog + state hashes; reject stale/missing observations.
3. Resolve agreements and active rate cards per effective schedule.
4. Match charge bases; enforce exclusive groups.
5. Build baseline workload financial snapshot F(baseline).
6. Build candidate workload snapshot F(baseline + candidate).
7. Compute incremental billed/effective/dueNow via delta.
8. Apply allowances/credits/commitments in priority order (exact decimals).
9. Compute consumption, headroom, projected waste, amortization per options.
10. Populate lines, assumptions, unpriced, eligibility; advisory allocatedEffective only.
11. Hash quote vector deterministically (stable field order).
12. Emit structured rejections for any partial path (no silent zero).

## Routing objectives

`maximize-credits` (legacy) | `min-incremental-billed` (CI default) | `min-incremental-effective`; expiry/waste tie-breaks; hysteresis on like-for-like basis.

## Reservations & reconciliation

CAS on state `seq`; pin quote/catalog/capability/state hashes; exact restore on release; reconciliation append-only.

## Integration

- **Dispatcher v2** beside untouched **v1** (`DispatchCostQuote` without `allocatedEffective`)
- **CI legacy translator**: move `packages/ci/src/accounting.ts` and sandbox rating behind `@hobo/pricing/legacy` — **move, do not rewrite**; v2 fail-closed unknown allocation
- **Cloud**: `commercialProductRefs` + versioned `pricingCatalogHash` / `capabilityCatalogHash` without changing `catalogHashOf`
- **Broker**: BillingPlane v2 quote authorization; keep legacy `spendEstimateUsd`
- **Events**: `pricing.RateCardPublished`, `ProviderAgreementObserved`, `GrantObserved`, `CommitmentObserved`, `QuoteCreated`, `Reservation*`, `ActualChargeObserved`, `ReconciliationRecorded`

Implementation status: `@hobo/pricing` ships the quote engine and golden corpus; `@hobo/events` pins `pricing.QuoteCreated@v1` for replay gates. Remaining event bodies follow the same append-only corpus pattern when actors land.

## Section 13 — adversarial fixtures (10.1–10.11)

1. Existing vs new subscription $20/1000 min/$0.01 with 950 used → $0.50 incremental
2. Paid $9-for-$10 vs promotional credits
3. $100 commitment, $40 used + $30 candidate
4. Graduated vs volume: 90+20 units → −$2 delta
5. Multidimensional sandbox composite
6. Migration source + target
7. Free hard-limit plan
8. Stale observations → reject
9. Multi-currency rejection
10. Joint non-additive actions
11. Zero-cost ties; hourly commitment buckets

## Package layout

`packages/pricing/{data-models/{pricing.proto,pricing.cue,fixtures},src/{index,types,decimal,units,catalog,state,rating,quote,external-quote,legacy,json}.ts,contracts/{consumer,pacts},test,corpus}`

No imports from ci/dispatcher/broker/cloud/adapters (except legacy **exports** consumed by ci).

## Phases

- **0**: Design + ADR + proto/CUE baseline + golden corpus scaffold
- **1**: Decimal/units + catalog parse (fail closed)
- **2**: Agreements, grants, commitments
- **3**: FinancialStateView + QuoteEngine + QuoteVector
- **4**: Legacy CI translator + dispatcher v2 adapter
- **5**: Broker/cloud hooks, events, PACT, CI workflow, conformance registration

## Guardrails (§14)

Do not widen BillingPolicy; no new CreditAccount/Offer fields; no dispatcher→CI dependency; no executable pricing; missing ≠ zero; no summing joint quotes; no auto-purchase/cancel; one cost basis per ranking field; **v1 dispatcher hashes/replay byte-identical**; no live price accuracy claims.
