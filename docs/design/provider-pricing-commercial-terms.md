---

type: Design
title: "HoBo Provider Pricing And Commercial Terms"
description: "Implementation design for provider-neutral products, rate cards, agreements, grants, commitments, quoting, and financially routed placement."
status: Proposed
repository: "https://github.com/Hobo-Labs/HoBo"
baseline: "921ad419e76a4773e037dd33d095127e5846855b"

---

# HoBo Provider Pricing And Commercial Terms

## 1. Executive decision

Add a new **`@hobo/pricing`** package that models what providers charge and produces deterministic, auditable quotes. Keep it separate from HoBo's customer-facing billing, payments, tax, entitlement, and invoice ambitions.

The central abstraction is not `subscription | metered | flat | credits`. Those are composable aspects of one commercial arrangement:

- A **ProviderProduct** identifies something a provider sells.
- An immutable **RateCard** versions its fixed, recurring, and usage charges.
- A **ProviderAgreement** binds a provider account to a plan or contract.
- **AllowanceGrants**, **CreditGrants**, and **Commitments** remain different financial instruments.
- A versioned **FinancialStateView** supplies observed agreements, balances, spend, and provenance.
- A pure **QuoteEngine** evaluates a scenario against a baseline and returns a **QuoteVector**, not just a unit price.

The dispatcher should rank candidate quotes; it should not reimplement pricing. CI, placement, traffic routing, and migration should all call the same quote engine.

Preserve the existing dispatcher v1 and `CreditLedgerView` replay path. Add the richer model beside it and migrate callers incrementally. Never rewrite a persisted price, grant, agreement, quote, or actual-cost fact; append a new version or correction.

### Normative decisions

1. **Quote deltas, not isolated usage.** Compute `F(baseline + candidate) - F(baseline)` using the same account period and commercial snapshot.
2. **Return several cost bases.** At minimum: incremental billed cost, the subset due immediately, incremental recognized effective cost, workload-allocated effective cost, and new future obligations.
3. **Do not equate zero incremental cash with zero economic cost.** Paid credits and prepaid commitments retain an economic basis. Keep scenario-delta and workload-allocated views distinct; the latter is advisory and follows a pinned allocation convention.
4. **Do not hide obligations.** A candidate requiring a new subscription, minimum term, or early termination is ineligible by default until policy explicitly permits that action.
5. **Fail closed on incomplete pricing.** Unknown, stale, unsupported, ambiguous, or cross-currency quotes cannot participate in automatic financial ranking. They are never treated as zero cost.
6. **Use exact decimal arithmetic.** Wire values are decimal strings; internal arithmetic is scaled integer arithmetic. Provider rounding rules are explicit.
7. **No live provider calls in a decision or replay.** External/dynamic prices must already exist as persisted, expiring, provenance-bearing quotes.
8. **Taxes, payments, customer invoices, and HoBo subscription billing are out of scope.** This is provider-cost modeling for FinOps and routing.

## 2. What the repository already does

The design extends working mechanisms rather than replacing them.

| Current location | Current behavior | Consequence for this design |
| --- | --- | --- |
| `packages/dispatcher/src/dispatcher.ts` | Pure, deterministic ranking over registry + `CreditLedgerView@seq`; supports free headroom, credits, budgets, rate/concurrency headroom, switching cost, expiry, hysteresis, and reservation CAS. | Keep snapshot pinning, deterministic tie-breaks, hysteresis, and reservations. Replace only the financial-input/rating seam over time. |
| Same file | `CreditAccount` carries one `dimension`, one `listUnitCost`, aggregate free headroom, and simple grants. `effectiveMarginalCost` is `(paidUnits * listUnitCost + switchingCost) / units`. | Cannot faithfully represent subscriptions, multidimensional usage, period tiers, commitments, or paid-credit basis. Do not keep adding fields to this scalar formula. |
| Same file | Decisions pin ledger sequence and balance hash; `replayDispatchDecision` reproduces v1 decisions. | v1 code, hashes, corpus, and replay behavior must remain intact. Introduce a versioned quote-based path. |
| `packages/ci/data-models/ci.proto` | `Offer` mixes provider binding with observed free minutes, unit price, spend, budget, validity, source URL, and optional sandbox price/allowance records. | Financial observations already have the right provenance/freshness instinct. Map them into a financial snapshot; do not move them into desired policy. |
| `packages/ci/src/routing.ts` | Computes a full reservation quote, including held/spent budgets and sandbox dimensions, then calls the dispatcher for final ranking. | CI already proves that candidate rating belongs before final dispatch. Generalize this into the shared engine and leave dispatcher with ranking only. |
| `packages/ci/src/accounting.ts` | Uses decimal decomposition and `BigInt` to avoid over-reserving free allocations and over/undercharging at serialization boundaries. | Reuse its conservative arithmetic lessons. Do not build the new engine on binary floating-point money. |
| `packages/ci/src/policy.ts` + `packages/ci/data-models/policy.proto` | Authored `DesiredCiPolicy` contains provider intent, account budget, routing strategy, and thresholds; financial observations and leases live elsewhere. | Preserve the intent/observation split and the guard that observations cannot alter policy or bindings. |
| `packages/broker/src/types.ts` and `data-models/broker.proto` | `BillingPolicy` is quota + `budgetUsd` + `spendCapUsd`; `BrokerCatalogDefinition.cost` is `sku/unit/marginalPrice`. | Keep `BillingPlane` as authorization. Add quote evidence to v2 placement receipts rather than turning it into a customer billing engine. |
| `packages/broker/src/planes.ts` and `metering.ts` | `BillingPlane.authorize` checks estimated spend against caps and metered remaining budget. | Let it authorize a selected quote's policy-chosen cost basis. Preserve the legacy `spendEstimateUsd` adapter. |
| `packages/broker/src/budget-signals.ts` | Deterministically folds usage/credit facts into replay-safe threshold signals. | Reuse signal machinery; do not conflate a budget with a wallet or a credit balance. |
| `packages/cloud/src/registry/catalog.ts` | Provider manifests lower to `ResourceDefinition.cost={sku,unit,marginalPrice}` and a content-hashed catalog. | Add commercial references alongside legacy cost. Pin a separate complete pricing-catalog hash; do not silently change the legacy catalog-hash algorithm. |
| `docs/design/usage-metering.md` | Usage facts and showback are explicitly not a billing engine, entitlement service, provider billing sync, or customer bill. | Reuse usage facts and attribution. Keep rating/reconciliation as a separate, explicit layer. |
| `docs/design/billing-launch-policy.md` and `tax-currency-receipt-obligations.md` | Hosted-business plans, payments, invoices, tax, and receipts are separate launch concerns. | Do not import those concerns into provider routing. Provider charges here are HoBo's COGS, not customer revenue. |
| `docs/design/reliability-observability-cost.md` | Cost signals are estimates, actual bills require reconciliation, and commitment optimization is advisory. | Preserve estimate/actual distinction and propose-only commitment purchases. |
| `docs/design/finops-budget-routing-control-plane.md` | Existing FinOps scope excludes billing, tax, payment collection, and live provider billing sync; the spine composes existing cost/metering/credit records. | Phase 0 must explicitly amend scope for offline provider-price rating and map FOCUS observations rather than introduce a competing actual-cost spine. |

### Main architectural gap

There are currently several correct but narrow cost shapes: one unit price in the cloud catalog, free minutes + unit price in CI, multidimensional sandbox pricing, and simple credit headroom in the dispatcher. Adding subscription fields independently to each would create divergent semantics. The missing component is a **single rating engine and commercial snapshot contract** feeding all of them.

## 3. Goals and non-goals

### Goals

- Model provider products across SaaS, PaaS, IaaS, CI, marketplaces, self-hosted infrastructure, and hardware.
- Compose fixed, one-time, recurring, licensed/seat, metered, package, graduated, and volume charges.
- Represent account-specific plans, negotiated rates, included allowances, paid/promotional credits, and spend/usage commitments.
- Quote placement, dispatch, traffic rebalancing, and migration using explicit cost bases and horizons.
- Preserve deterministic replay, exact arithmetic, evidence freshness, reservation safety, and tenant isolation.
- Support provider-specific models without executable expressions embedded in JSON.
- Reconcile estimates with actual provider cost records later, including FOCUS-shaped imports.

### Non-goals for the initial implementation

- HoBo customer subscriptions, invoices, checkout, payment collection, refunds, dunning, tax, or revenue recognition.
- A general-purpose accounting ledger or a replacement for Stripe, Polar, OpenMeter, or Lago.
- Automatic purchase, upgrade, cancellation, or renewal of a provider agreement.
- Portfolio optimization across several simultaneous placements. The schema supports a compound scenario, but the first dispatcher still quotes one candidate action at a time.
- Live cloud billing synchronization in the pure decision path.
- Automatic FX conversion, provider-specific tax calculation, or total-cost-of-ownership guesses without inputs.
- Perfect equivalence of provider SKUs. Capability matching remains owned by cloud/capability-profile packages.

## 4. Prior art: what to borrow and what not to copy

| System | Useful pattern | Limit for HoBo's problem |
| --- | --- | --- |
| Stripe Billing | Product/Price separation; flat + metered items on one subscription; meter aggregation; decimal unit amounts; quantity transformation; scoped credit grants with effectiveness, expiry, category, and priority. | Primarily customer monetization. Its credit and subscription semantics do not directly answer provider COGS, amortized commitments, or migration economics. |
| PayPal Subscriptions | Simple fixed, quantity/seat, volume, and tiered plan models. | A useful baseline, but not rich enough for multidimensional infrastructure rating or provider account observations. |
| Polar | Events -> filtered/aggregated Meters -> metered product prices; recurring meter-credit benefits. | Good validation of the meter/charge/grant decomposition; still not a cloud actual-cost standard. |
| OpenMeter | Versioned plans, flat and usage charges, entitlements, credit grants with recurrence, expiry, rollover, and burn-down priority. | Close conceptual prior art. HoBo should borrow grant semantics but keep provider agreements and quote bases explicit. |
| Lago | Billable metrics independent from payment processing; hybrid plan charges; wallets, commitments, customer-specific rates, and multiple pricing models. | Reinforces that pricing is not payments. HoBo needs deterministic routing quotes rather than an invoice subsystem. |
| FinOps FOCUS | Separate billed, effective, list, and contracted cost; explicit commitment usage and amortization; actual cost-and-usage records. | FOCUS normalizes observed charges, not the commercial rules needed to price a hypothetical action. Use it for reconciliation, not as the RateCard schema. |

**Design conclusion:** use payment/billing systems for catalog and grant ideas; use FinOps models for cost bases and reconciliation. Do not force either to serve the other's role.

### Alternatives rejected during design review

- **Keep extending `CreditAccount` and CI `Offer`:** smallest first diff, but every new commercial feature would change ranking and persisted lease semantics across several packages.
- **Adopt Stripe/PayPal/Polar objects wholesale:** useful catalog inspiration, but customer subscription objects do not model provider COGS, migration, unused commitments, or actual-cost reconciliation.
- **Use FOCUS as the rate-card format:** appropriate for actual charges, not for evaluating hypothetical future actions.
- **Allow executable provider pricing expressions:** maximally flexible, but weakens deterministic replay, parser safety, schema compatibility, and tenant trust.
- **Return one scalar effective price:** convenient for the existing ranker, but financially misleading whenever fixed fees, prepaid assets, obligations, or migration are present.

## 5. Domain boundaries

```text
Provider capability catalog              Provider commercial catalog
ResourceDefinition / CI Offer            ProviderProduct + immutable RateCard
          |                                        |
          | commercialProductRefs                  | selected by ProviderAgreement
          v                                        v
                 QuoteScenario + UsageProfile
                            +
             FinancialStateView @ seq/hash
             (agreements, grants, commitments,
              spend, actuals, provenance)
                            |
                            v
                     pure QuoteEngine
                            |
                            v
                       QuoteVector
             billed / dueNow / effective /
             obligations / lines / consumption
                            |
             +--------------+---------------+
             |                              |
       Dispatcher ranking             BillingPlane /
       + hysteresis                  budget authorization
             |
             v
     reservation -> actual usage -> reconciliation/correction
```

### Ownership rules

- `@hobo/pricing` owns commercial schemas, exact rating, quote vectors, and financial snapshot parsing/folding.
- `@hobo/cloud` and provider adapters own capability matching and commercial-product references.
- `@hobo/dispatcher` owns deterministic candidate ranking, hysteresis, and dispatch reservations. It consumes structural quote data and does not rate products.
- `@hobo/ci` owns CI demand, lease lifecycle, and provider execution. It delegates commercial rating to `@hobo/pricing`.
- `@hobo/broker` owns placement authorization and receipts. `BillingPlane` remains a budget/spend-cap gate.
- Existing usage metering owns usage facts and attribution. Pricing consumes those facts; it does not duplicate ingestion.
- Provider adapters own translation from provider catalogs/observations into HoBo records and from HoBo commercial references into provider identifiers.

## 6. Normative logical model

The following TypeScript illustrates semantics, not generated wire code. Implementation must define equivalent Protobuf contracts, CUE invariants, and parsed domain types. `Decimal` and timestamps are strings on the wire.

### 6.1 Common primitives

```ts
type Decimal = string;             // canonical base-10; no NaN/Infinity/exponent on wire
type ISODateTime = string;        // UTC at decision boundaries
type CurrencyCode = string;       // ISO 4217
type DimensionId = string;        // e.g. "runner.minutes", "compute.vcpu_ms"
type ProductId = string;
type RateCardId = string;
type ProviderAgreementId = string;
type GrantId = string;
type CommitmentId = string;

interface Money {
  currency: CurrencyCode;
  amount: Decimal;                // major units; exact, may be fractional
}

interface Quantity {
  dimension: DimensionId;
  unit: string;                   // canonical unit declared by the meter
  value: Decimal;
}

interface EvidenceRef {
  source: "provider-api" | "provider-document" | "operator" | "external-quote" | "actual-bill";
  sourceUrl?: string;
  externalId?: string;
  observedAt: ISODateTime;
  validUntil?: ISODateTime;
  contentHash: string;
}

interface Interval {
  start: ISODateTime;             // inclusive
  end?: ISODateTime;              // exclusive
}
```

Rules:

- Define a canonical decimal parser and serializer. Reject excessive precision/length, negative zero, unsafe exponents, and values outside configured scale limits.
- Currency amounts remain in original currency on quote lines. Conversion requires an explicit pinned FX record; v1 rejects cross-currency ranking instead.
- Dimensions are not bare display labels. A meter declares its canonical unit and exact allowed conversions (`60 s = 1 min`, `1 GiB = 2^30 bytes`). `GB` versus `GiB` must never be inferred.
- `validUntil` applies to the whole action horizon, not just quote creation. An allowance expiring halfway through a reserved job cannot cover the whole job.
- New Protobuf money and quantity fields use strings, never `double`. v2 comparison uses exact scaled integers/canonical decimals only; decimal strings must never enter v1's number/string-mixed rank vector or interact with `LARGE_SCORE`.
- Legacy conversion happens once in an adapter: floor available headroom and ceil charges, matching CI's conservative accounting. Legacy JS-number behavior remains unchanged inside v1. v2 does not reuse v1 numeric sentinels.

### 6.2 Provider product and immutable rate card

```ts
interface ProviderProduct {
  id: ProductId;                  // HoBo-stable ID, not inferred from providerId
  providerId: string;
  externalProductIds: string[];   // provider catalog/SKU/plan identifiers
  name: string;
  kind: "service" | "plan" | "sku" | "bundle" | "hardware";
  meters: MeterDefinition[];
  extensions?: Record<string, unknown>; // namespaced data only; never behavior
}

interface MeterDefinition {
  dimension: DimensionId;
  unit: string;
  aggregation: "sum" | "max" | "latest" | "unique-count";
  uniqueKey?: string;
  rounding?: {
    scope: "event" | "period";
    multiple: Decimal;
    mode: "ceil" | "floor" | "half-up";
  };
}

interface RateCard {
  id: RateCardId;                 // new ID on every semantic change
  productId: ProductId;
  version: string;
  currency: CurrencyCode;
  effective: Interval;
  charges: ChargeComponent[];
  evidence: EvidenceRef;
  extensions?: Record<string, unknown>;
}

type ChargeComponent = FixedCharge | UsageCharge;

interface ChargeBase {
  id: string;
  match?: Record<string, string | string[]>; // exact structured selectors only
  exclusiveGroup?: string;        // SKU alternatives; exactly one selected
  fallback?: boolean;             // optional default within an exclusiveGroup
  invoiceBehavior: "included" | "separate" | "not-invoiced";
}

interface FixedCharge extends ChargeBase {
  kind: "fixed";
  cadence: "once" | "daily" | "weekly" | "monthly" | "yearly";
  timing: "advance" | "arrears";
  amount: Money;
  quantityDimension?: DimensionId; // seats, hosts, cores; default = 1
  proration: "none" | "calendar-day" | "exact-second";
}

interface UsageCharge extends ChargeBase {
  kind: "usage";
  dimension: DimensionId;
  timing: "advance" | "arrears";
  price: PerUnitPrice | PackagePrice | GraduatedPrice | VolumePrice;
}

interface PerUnitPrice {
  kind: "per-unit";
  unitAmount: Money;               // per canonical meter unit
}

interface PackagePrice {
  kind: "package";
  packageSize: Decimal;
  packageAmount: Money;
  rounding: "ceil" | "floor";      // normally ceil for purchased blocks
}

interface Tier {
  from: Decimal;                  // inclusive, normalized quantity
  to?: Decimal;                   // exclusive; omitted = unbounded
  flatAmount: Money;
  unitAmount: Money;
}

interface GraduatedPrice {
  kind: "graduated";              // each tier prices only its own units
  tiers: Tier[];
}

interface VolumePrice {
  kind: "volume";                 // total quantity selects one tier for all units
  tiers: Tier[];
}
```

A flat monthly fee and metered overage are two components on one rate card. A PaaS product can have CPU, memory, requests, creation, and egress components. A hardware product can combine an upfront purchase, recurring support, and usage charges. No `billingModel: subscription` flag is needed.

Charges are additive unless they declare an `exclusiveGroup`. Within a group, select exactly one matching non-fallback charge; if none matches, select one declared fallback. Zero or multiple eligible alternatives fail closed. This prevents base and region/SKU alternatives from being double-charged without forbidding genuinely additive base + usage components.

A rate card is catalog data, not an observation that an untrusted publisher may overwrite. Publication is content-addressed and approved through the same trust posture as provider catalogs.

### 6.3 ProviderAgreements, allowances, credits, and commitments

`ProviderAgreement` is deliberately provider-prefixed: it is a FinOps commercial-terms record, not a PACT contract or a customer billing subscription.

```ts
interface ProviderAgreement {
  id: ProviderAgreementId;
  tenantId: string;
  providerAccountRef: string;      // reference, never a credential
  productId: ProductId;
  rateSchedule: Array<{ rateCardId: RateCardId; effective: Interval }>; // negotiated/custom cards and future changes
  status: "trialing" | "active" | "past-due" | "suspended" | "cancelled";
  term: Interval;
  billingPeriod: {
    interval: "daily" | "weekly" | "monthly" | "yearly" | "manual";
    anchor: ISODateTime;
    timeZone: string;              // explicit; UTC for v1 automated routing
  };
  quantities: Quantity[];          // seats/hosts/licensed quantities
  cancellation: {
    allowed: boolean;
    refund: "none" | "prorated" | "full";
    fee?: Money;
    notice?: string;
  };
  evidence: EvidenceRef;
}

interface GrantScope {
  productIds?: ProductId[];
  rateCardIds?: RateCardId[];
  chargeIds?: string[];             // interpreted within the scoped rate cards
  dimensions?: DimensionId[];
}

interface AllowanceGrant {
  id: GrantId;
  agreementId?: ProviderAgreementId;
  derivedFrom?: string;            // parent fixed charge; its economic basis is not counted again
  scope: GrantScope;
  quantity: Quantity;              // included usage, not money
  recurrence?: { interval: "daily" | "weekly" | "monthly" | "yearly"; anchor: ISODateTime };
  effective: Interval;
  rollover: { max?: Decimal; reset: "none" | "period" };
  exhaustion: "bill-overage" | "block-usage";
  priority: number;
  evidence: EvidenceRef;
}

interface CreditGrant {
  id: GrantId;
  agreementId?: ProviderAgreementId;
  derivedFrom?: string;            // parent fixed charge; its economic basis is not counted again
  scope: GrantScope;
  category: "paid" | "promotional" | "support-adjustment";
  faceValue: Money | Quantity;     // monetary and unit credits stay distinct
  economicBasis:                   // used for effective-cost quotes
    | { kind: "zero" }
    | { kind: "acquisition"; amount: Money }
    | { kind: "face-value" };
  effective: Interval;
  recurrence?: { interval: "monthly" | "yearly"; anchor: ISODateTime };
  rollover: { max?: Decimal; reset: "none" | "period" };
  priority: number;
  evidence: EvidenceRef;
}

interface Commitment {
  id: CommitmentId;
  agreementId: ProviderAgreementId;
  scope: GrantScope;
  kind: "spend" | "usage";
  amount: Money | Quantity;
  bucketGranularity: "hour" | "day" | "month" | "billing-period" | "term";
  term: Interval;
  payment: "upfront" | "recurring" | "mixed";
  underuse: "forfeit" | "rollover" | "true-up";
  amortization: "straight-line" | "provider-actual";
  evidence: EvidenceRef;
}
```

These instruments are not interchangeable:

- An **allowance** is included usage. Exhaustion may block usage or permit overage.
- A **credit** is a consumable monetary or unit asset. Paid credits reduce later billed charges but have an acquisition/economic basis.
- A **commitment** is an obligation to pay for spend/usage regardless of full utilization. Unused commitment is visible and is not a free credit balance.
- A **discount** changes a rate. Represent negotiated rates as an account-specific immutable RateCard in v1 rather than introducing an ambiguous discount-composition language.

A grant derived from a recurring plan component must name `derivedFrom`. For v1, the parent component owns the full economic basis and the derived grant has zero additional basis. CUE rejects a derived grant that also declares acquisition or face-value basis. An alternative flow-through allocation requires a new version; never count both. For an independently purchased, partially consumed credit, acquisition basis is allocated pro rata from its original face value using exact arithmetic. Commitments are consumed at their declared `bucketGranularity`: an idle hour cannot fund a later burst hour. A coarser accumulator is permitted only as an explicit assumption; otherwise the quote fails closed.

### 6.4 Versioned financial state

```ts
interface FinancialStateView {
  view: "FinancialStateView";
  schema: "hobo.pricing/v1";
  tenantId: string;
  seq: number;
  stateHash: string;
  asOf: ISODateTime;
  agreements: ProviderAgreement[];
  allowances: ObservedAllowance[];
  credits: ObservedCredit[];
  commitments: ObservedCommitment[];
  periodActuals: ActualCharge[];
  completeness: "complete" | "partial";
  observations: EvidenceRef[];
}

interface ObservedAllowance {
  grant: AllowanceGrant;
  remaining: Decimal;
  observedAt: ISODateTime;
}

interface ObservedCredit {
  grant: CreditGrant;
  remaining: Decimal;
  observedAt: ISODateTime;
}

interface ObservedCommitment {
  commitment: Commitment;
  used: Decimal;
  unused: Decimal;
  observedAt: ISODateTime;
}

interface ActualCharge {
  id: string;
  productId?: ProductId;
  agreementId?: ProviderAgreementId;
  chargePeriod: Interval;
  quantity?: Quantity;
  billedCost: Money;
  effectiveCost?: Money;
  listCost?: Money;
  contractedCost?: Money;
  category: "usage" | "purchase" | "credit" | "adjustment" | "tax";
  commitmentId?: CommitmentId;
  commitmentStatus?: "used" | "unused";
  evidence: EvidenceRef;
}
```

`FinancialStateView` is the rich successor input for new callers; it is not a breaking rename of `CreditLedgerView`. A legacy adapter derives old free headroom/list price only when doing so is semantically lossless.

An observation with `completeness: "partial"` may support informational showback, but not automatic financial selection unless policy explicitly narrows and names the missing scope. Missing price, grant, or actual data is not zero. Every v2 automatic candidate requires persisted, unexpired, content-hashed evidence for its rate and provider-agreement terms, plus current financial observations for every consumed asset. Never fall back to a candidate-declared `listUnitCost`, and never treat missing budget information as unbounded headroom. Rejection includes a structured `rejectedCandidates` reason.

`FinancialStateView` is the decision-side projection, not a second native cloud-bill format. `ActualCharge` is the mapping target for existing FOCUS/`FocusCostLedgerEntry` imports; preserve that source lineage rather than creating competing actual-cost records.

## 7. Quote contract and rating semantics

### 7.1 Scenario input

```ts
interface QuoteScenario {
  id: string;
  tenantId: string;
  action: "place" | "dispatch" | "rebalance" | "migrate" | "cancel";
  at: ISODateTime;
  horizon: Interval;
  pricingCatalogHash: string;
  state: FinancialStateView;
  baseline: WorkloadDelta[];        // usually current committed workload
  candidate: WorkloadDelta[];       // one or more joint changes
  sourceProviderAgreementIds?: ProviderAgreementId[]; // migration/cancellation context
  options: {
    allowNewProviderAgreement: boolean;      // default false
    allowCancellation: boolean;      // default false
    amortization: "straight-line" | "provider-actual";
    allocationConvention: "marginal-consume" | "period-proportional";
    allocationForecast?: Array<{ basisOwnerId: string; expectedEligible: Money | Quantity }>;
  };
}

interface WorkloadDelta {
  productRef: ProductId;
  agreementRef?: ProviderAgreementId;       // omit only when a new agreement is being evaluated
  direction: "add" | "remove";
  quantities: Quantity[];           // licensed/fixed quantities
  usage: UsageMeasurement[];
  attributes: Record<string, string>; // region, OS, shape, source/destination, etc.
}

interface UsageMeasurement {
  eventId: string;
  dimension: DimensionId;
  value: Decimal;
  at: ISODateTime;
  attributes: Record<string, string>;
}
```

Usage remains event-shaped where rounding is event-scoped. A pre-aggregated `UsageVector` optimization is allowed only when the meter proves that aggregation and rounding commute.

A compound candidate is rated jointly. Quotes for separate candidates are not assumed additive: fixed fees, tiers, allowances, and commitments make that unsafe. `period-proportional` allocation requires an `allocationForecast` for every affected parent component, credit pool, or commitment; the forecast and its denominator are recorded as assumptions and included in the quote hash.

### 7.2 Quote output

```ts
interface QuoteVector {
  schema: "hobo.pricing.quote/v1";
  ratingAlgorithmVersion: string;
  scenarioId: string;
  subjects: Array<{ productRef: ProductId; agreementRef?: ProviderAgreementId }>;
  currency: CurrencyCode;
  horizon: Interval;
  pricingCatalogHash: string;
  stateHash: string;
  stateSeq: number;
  quoteHash: string;

  baselineBilled: Money;
  candidateBilled: Money;
  incrementalBilled: Money;        // candidateBilled - baselineBilled
  dueNow: Money;                   // subset of incrementalBilled due immediately

  baselineEffective: Money;
  candidateEffective: Money;
  incrementalEffective: Money;     // delta in total recognized cost

  allocationConvention: "marginal-consume" | "period-proportional";
  allocatedEffective?: Money;      // advisory unit economics; not a dispatcher ranking input
  nominalAtListRate?: Money;       // display-only, exposes promo/free usage nominal value

  newObligations: Obligation[];
  migrationAndTermination: Money; // informational subset of totals, not an extra addend
  lines: QuoteLine[];
  consumption: PlannedConsumption[];
  remainingHeadroom: Quantity[];
  projectedWaste: ProjectedWaste[];
  assumptions: string[];
  unpriced: UnpricedItem[];
  eligibility: EligibilityIssue[];
}

interface Obligation {
  kind: "new-agreement" | "recurring-charge" | "minimum-commitment" | "cancellation-fee";
  amount: Money;
  cadence?: string;
  term?: Interval;
  agreementAction: "create" | "change" | "cancel" | "none";
}

interface QuoteLine {
  chargeId: string;
  productId: ProductId;
  dimension?: DimensionId;
  quantity?: Decimal;
  baselineAmount: Money;
  candidateAmount: Money;
  billedDelta: Money;
  effectiveDelta: Money;
  explanation: string;
}

interface ProjectedWaste {
  kind: "allowance" | "credit" | "commitment";
  id: string;
  expiresAt?: ISODateTime;
  quantity?: Quantity;
  amount?: Money;
}

interface PlannedConsumption {
  kind: "allowance" | "credit" | "commitment";
  id: string;
  quantity?: Quantity;
  amount?: Money;
  basisAmount?: Money;
}
```

`incrementalBilled` approximates additional provider charges in the scenario horizon, not payment settlement. `dueNow` identifies upfront exposure. `incrementalEffective` is the change in total recognized cost and supports accrual-style comparison. `allocatedEffective` attributes economic basis to the workload for reporting; it is not added to either delta and is not available to the dispatcher as a ranking input. `nominalAtListRate` prevents promotional usage from appearing economically meaningless in showback without changing its basis.

`marginal-consume` allocation depends on pinned consumption order and can assign different basis to otherwise identical jobs. `period-proportional` uses a forecast denominator and must record that forecast as an assumption. Both conventions are versioned inputs to `quoteHash`; neither may silently become a live placement objective.

### 7.3 Required rating algorithm

For each candidate scenario, in this order:

1. **Parse and freeze inputs.** Reject invalid schemas, unsupported units, ambiguous product/agreement binding, and unsafe numeric values.
2. **Pin time and evidence.** Select the agreement effective at `scenario.at`, split the horizon at billing-period and `rateSchedule` boundaries, and select the applicable rate card for each slice. Require evidence validity through the horizon where a reservation depends on it.
3. **Resolve period baseline.** Derive current usage, actual charges, grant balances, commitment use, and licensed quantities for each affected billing period.
4. **Select applicable charges.** Apply exact structured selectors for product, plan, region, shape, OS, network path, and declared provider dimensions.
5. **Normalize meter quantities.** Apply exact unit conversion and event/period rounding before pricing.
6. **Rate baseline and candidate independently.** Use the same pure period-rating function for both. Include fixed fees, recurring charges, packages, tiers, and overage.
7. **Apply allowances and commitments.** Follow provider scope and period semantics. Keep used and unused commitments visible.
8. **Apply credit grants.** Sort deterministically by explicit priority, earliest expiry, then grant ID. Monetary credits apply only to monetary charges; unit credits only to matching dimensions.
9. **Compute economic basis.** Add acquisition basis for independently purchased credits and recognized commitment/subscription amounts. Derived plan grants take the single parent-basis path described above. Do not relabel sunk cost as a new incremental charge or count a renewal once in recognized cost and again as an obligation addend.
10. **Evaluate source-side actions.** Include dual-run, data egress, setup, cancellation fees, and only contractually allowed refunds. Removing usage does not automatically cancel an agreement or create cash savings.
11. **Emit obligations and eligibility issues.** Any new agreement, minimum term, or cancellation requires explicit policy permission.
12. **Return the vector and consumption plan.** Include enough lines to explain the result and reserve the exact assets later.

Basis conservation is a conformance invariant, evaluated per allocation convention: for each acquired asset, `basisAllocated + basisRemaining + basisExpired = basisAcquired`; for each parent recurring component, `sum(derivedChildrenBasis) + unamortizedParentBasis = parentFee`. Reconciliation reports residuals instead of silently losing or duplicating basis.

For any period-rating function `F`, incremental billed cost is:

```text
incrementalBilled = F_billed(baseline + candidate) - F_billed(baseline)
```

Apply the same baseline-delta rule to recognized effective cost. Workload-allocated basis is a separate attribution calculation under the pinned allocation convention, not a third total to add to the scenario.

Do not calculate `F(candidate)` alone. Do not divide a subscription by a guessed number of jobs and call that its marginal cost.

A volume price can produce a negative incremental line when total usage crosses a retroactive discount boundary. Preserve and explain the arithmetic, but **never allow a negative candidate quote to create budget headroom or offset unrelated spend**.

### 7.4 Cost bases and routing policy

Keep routing lexicographic and deterministic; do not collapse every financial fact into an opaque weighted score.

```ts
type FinancialObjective =
  | "maximize-credits"              // legacy compatibility profile
  | "min-incremental-billed"       // short-horizon / CI default
  | "min-incremental-effective";   // long-horizon economic comparison
```

- `maximize-credits` retains the v1 ordering through a legacy adapter.
- `min-incremental-billed` ranks hard eligibility first, then incremental billed cost, expiry-sensitive asset use, capacity, switching cost, and stable IDs.
- `min-incremental-effective` uses recognized effective delta instead, while still exposing immediate cash and obligations to policy gates. `allocatedEffective` is structurally excluded from ranking.
- Among equal incremental costs, prefer the candidate that consumes the soonest-expiring committed/allowance headroom and reduces `projectedWaste`; then apply capacity and stable-ID tie-breaks. This avoids stranding expiring commitments through zero-cost ties.
- Compare only quotes with the same horizon, currency, allocation convention where relevant, and scenario semantics.
- Hysteresis compares like-for-like savings on the selected basis. It never overrides a hard budget, capacity, compliance, freshness, or eligibility failure.

A migration quote must include both target addition and source removal/action. A target-only unit-price comparison is not a migration decision.

## 8. Reservations, settlement, and replay

### Reservation flow

1. Build a candidate quote from pinned catalog and financial-state hashes.
2. Authorize hard policy against `dueNow`, `incrementalBilled`, new obligations, and eligibility issues.
3. Rank eligible candidates using the selected financial objective and existing hysteresis/stability controls.
4. Reserve the selected quote's allowance, credit, commitment, budget, and capacity consumption using CAS on the financial-state sequence.
5. Pin `quoteHash`, `pricingCatalogHash`, `capabilityCatalogHash` (when a capability binding was used), `stateHash`, `stateSeq`, and the complete consumption plan into the reservation/decision fact.
6. Confirm, release, or expire using the existing reservation lifecycle. Release restores the exact recorded consumption; it does not guess from current balances.
7. Requote before external side effects when evidence validity, price, policy, agreement, or binding changed. Existing CI `launchEligible` behavior is the model here.

A reservation is not a provider billing reservation. It is HoBo's local hold against double-spending financial headroom.

### Actual usage and corrections

- Record actual quantities through existing usage-metering facts.
- Rate actuals against the exact agreement/rate card effective for the usage period, not the latest card.
- Import provider charges as separate actual facts. Preserve native IDs and source evidence.
- Reconciliation emits variance and adjustment records. It never edits the original quote, reservation, usage event, or actual charge.
- Late actuals can trigger budget signals and future routing changes, but cannot rewrite an earlier decision.
- A negative correction is explicit; do not reuse the current non-negative-only usage fold for financial adjustments.

### Determinism contract

A quote is pure over:

```text
(schemaVersion, pricingCatalogSnapshot, financialStateView@seq,
 scenario, usageFacts, ratingAlgorithmVersion)
```

No wall-clock reads, network calls, environment variables, locale-sensitive formatting, or unordered iteration may affect output. Every decision records the rating algorithm version and content hashes. A changed algorithm requires a new schema/version and golden replay fixtures; old replay continues through its original version.

## 9. Extensibility without losing safety

### Closed core, typed escape hatches

Use closed discriminated unions for supported charge kinds and explicit namespaced extension data for provider-specific identifiers and selectors. Do not add a free-form `pricingExpression`, JavaScript, Rego, SQL, or CUE expression to provider documents.

When a provider cannot be represented by the core model:

1. A provider adapter may obtain a quote outside the decision path.
2. Persist an `ExternalProviderQuote` containing product/agreement references, action/usage fingerprint, cost vector, evidence, issue/expiry times, and optional signature.
3. The pure engine verifies that the persisted quote exactly matches the scenario and is fresh.
4. Replay reads the persisted quote; it never calls the provider again.

Unsupported models without such a quote produce `PRICING_MODEL_UNSUPPORTED` and are ineligible for automatic financial routing.

### Versioning

- Start with `hobo.pricing/v1` and `hobo.pricing.quote/v1`.
- Rate cards are immutable; changing a rate creates a new ID and hash.
- ProviderAgreements and observations are versioned facts, not mutable documents in desired policy.
- Protobuf field additions must follow compatibility rules; CUE enforces cross-field invariants.
- Event-body changes require the repository's total upcaster and append-only golden-replay treatment.
- Extension keys are namespaced, for example `x_vercel_plan` or `x_aws_sku`. They cannot alter generic ranking semantics.

### Bounds and validation

Set explicit maxima for products, charges per card, tiers per charge, usage measurements per scenario, decimal digits, selector keys, and extension payload size. Reject duplicate IDs, overlapping tiers, non-contiguous tiers, invalid period anchors, ambiguous selector matches, and grants with incompatible scope/unit.

## 10. Adversarial worked scenarios

All values below are synthetic fixtures, not claims about current provider prices.

### 10.1 Existing subscription versus new subscription

A plan charges $20/month, includes 1,000 runner minutes, then charges $0.01/minute. The account has used 950 minutes in the current period.

For a 100-minute candidate on the existing agreement:

- 50 minutes consume allowance; 50 are overage.
- `incrementalBilled = $0.50`; `dueNow = $0` for arrears billing.
- The already-active $20 subscription is not charged again.

For the same candidate requiring a new agreement:

- Include the new subscription under the specified proration rule plus $1.00 of usage.
- Emit a `new-agreement` obligation.
- Reject by default unless `allowNewProviderAgreement` is true.

A monthly fee divided by an assumed job count would have hidden this distinction.

### 10.2 Paid and promotional credits

A workload rates at $10. A paid monetary credit covers its $10 face value and was acquired for $9. A separate promotional credit covers $10.

| Case | Incremental billed | Due now | Workload-allocated effective basis |
| --- | ---: | ---: | ---: |
| Pay-as-you-go | $10 | Scenario-dependent | $10 |
| Paid credit | $0 | $0 | $9 |
| Promotional credit | $0 | $0 | $0 |

Credits included in an already-rated subscription must not receive a second acquisition basis; that would double count the subscription. Each asset has one economic-basis owner.

### 10.3 Spare commitment capacity

An account owes $100/month whether it uses the eligible capacity or not. Baseline recognized cost includes $40 of used commitment and $60 unused. A candidate consumes another $30.

- Incremental billed cost is $0.
- Incremental total recognized effective cost is $0: total remains $100.
- Workload-allocated effective cost is $30, while unused commitment falls from $60 to $30.
- Migration away does not automatically recover the remaining commitment.

This is why both scenario-delta and workload-allocated effective views are necessary.

### 10.4 Graduated versus volume pricing

At 90 baseline units, add 20 units:

- Graduated: the first 10 additional units use the current tier; the next 10 use the next tier.
- Volume: if 101+ units reprice all units at $0.80 from $1.00, `F(90)=$90` and `F(110)=$88`, so the incremental line is `-$2`.

Preserve the arithmetic and explanation. Do not clamp the line to zero, but do not let it offset unrelated budget consumption.

### 10.5 Multidimensional PaaS

A sandbox candidate has CPU-time, memory-time, creation, and egress charges plus independent allowances. Rating must produce separate lines and consumption entries. A runner-minute credit cannot pay for sandbox CPU or egress. Any missing dimension makes the quote partial and ineligible for automatic routing.

### 10.6 Migration with a source agreement

Moving a workload from provider A to B may involve:

- B setup and recurring charges;
- A's non-refundable subscription or unused commitment;
- A data-egress charge;
- dual-run cost during cutover;
- an explicit A cancellation fee, if policy permits cancellation.

The quote must model source and target in one compound scenario. “B has a lower unit price” is insufficient evidence for migration.

### 10.7 Free plan with a hard limit

A free plan includes 100 requests and blocks further usage. It is not an infinite $0 offer. Once headroom is exhausted, the candidate is ineligible; the rating engine must not invent a $0 overage charge.

### 10.8 Stale or partial observations

A provider publishes a valid unit price but the account's remaining allowance observation is expired. The system may show an informational list-price estimate, but automatic `maximize-credits` routing must reject the candidate rather than assume either free usage or zero allowance.

### 10.9 Multiple currencies

A USD quote and EUR quote are not directly comparable. v1 rejects automatic ranking. A later version may introduce a pinned FX record with source, timestamp, rate, and policy-selected conversion basis.

### 10.10 Joint actions are not additive

Two candidates each appear to fit the same remaining allowance independently. Accepting both exceeds it. A compound scenario must rate them together, and reservations must CAS against the same state sequence.

### 10.11 Zero-cost ties and hourly commitment buckets

Two providers can both have zero incremental cost because both have spare commitments. Ranking must consider projected expiry/waste or it can strand the commitment closest to expiry. Separately, an hourly $1 commitment cannot fund a $5 burst in one hour merely because the account is below its monthly average. The quote must consume the hourly bucket or fail closed; a monthly approximation requires an explicit assumption and must not be presented as exact provider semantics.

## 11. Repository integration plan

### 11.1 New `@hobo/pricing` package

Proposed initial layout:

```text
packages/pricing/
  data-models/
    pricing.proto
    pricing.cue
    fixtures/
  src/
    index.ts
    types.ts
    decimal.ts
    units.ts
    catalog.ts
    state.ts
    rating.ts
    quote.ts
    external-quote.ts
    legacy.ts
    json.ts
  contracts/
    consumer/
    pacts/
  test/
```

Responsibilities:

- Protobuf/CUE wire contracts and parse-don't-validate domain types.
- Exact decimal/unit arithmetic.
- Immutable catalog and versioned financial-state folds.
- Pure rating and quote vectors.
- Legacy CI/dispatcher adapters that are explicitly lossless.
- No imports from CI, dispatcher, broker, cloud, or provider adapters.

Update `docs/design/package-namespaces.md` so ownership and dependency direction are explicit.

### 11.2 Dispatcher: add quote-based v2 beside v1

Keep `CreditLedgerView`, `DISPATCHER_SCHEMA_VERSION = "hobo.dispatcher/v1"`, and `replayDispatchDecision` behavior unchanged.

Add a separate quote-based input/path with structural candidate fields similar to:

```ts
interface DispatchCostQuote {
  quoteHash: string;
  pricingCatalogHash: string;
  stateHash: string;
  stateSeq: number;
  ratingAlgorithmVersion: string;
  incrementalBilled: Money;
  dueNow: Money;
  incrementalEffective: Money;
  projectedWaste: ProjectedWaste[];
  eligibility: EligibilityIssue[];
  // allocatedEffective is deliberately absent from this ranking boundary.
}

interface DispatchQuoteCandidate {
  providerId: string;
  definitionId?: string;
  quote: DispatchCostQuote;
  rateHeadroom?: Decimal;
  concurrencyHeadroom?: Decimal;
}
```

The dispatcher may define a minimal structural quote interface to avoid a package cycle. It ranks returned vectors and never recomputes charge lines. v2 decisions pin quote/catalog/state hashes and rating version. Reservation code remains shared only where semantics are identical; grant consumption is persisted in the financial-state reservation record rather than squeezed into legacy `ReservedConsumption`.

### 11.3 CI: replace parallel commercial logic incrementally

- Add a legacy translator from `Offer` + `Account` + leases into catalog/state/scenario inputs.
- Simple `freeMinutes + priceMicrosPerMinute` becomes a per-unit usage charge plus allowance grant.
- `SandboxPricing` becomes fixed/usage charge components; `SandboxAllowance` becomes dimension-scoped grants. The existing protobuf name remains for legacy compatibility, but `@hobo/pricing` becomes the only generic rating owner.
- Move the existing allocation and sandbox rating implementations behind the new package and have CI import/re-export the legacy lane; do not write a second version from scratch. Preserve conservative ceiling/floor behavior, plan/region validation, and fail-closed candidate exclusion. CI retains budget/capacity policy gates but v2 stops computing `paid` locally.
- Keep desired `CiPolicyProvider` free of prices, balances, agreements, and credits.
- Keep existing provider inventory, observation freshness, and binding guards.
- Preserve legacy `routing.unknownAllocation: "zero"` only in v1. A v2 policy must use an explicit unavailable/fail-closed value; never reinterpret an old policy or silently carry `zero` into quote-based routing.
- Route v2 by obtaining candidate `QuoteVector`s and passing the restricted `DispatchCostQuote` projection to the dispatcher.
- Dual-write new commercial references while continuing to populate legacy Offer/lease price and allowance fields until every reader and in-flight lease has drained. Never require a new ref to interpret an old lease.
- Retain `allocationQuote` and legacy lease fields for v1 replay and in-flight lease settlement until a versioned migration drains them. Do not change persisted lease semantics mid-lease.

### 11.4 Cloud catalog and provider adapters

- Add optional `commercialProductRefs` to v2 resource definitions/offers. Keep legacy `cost` for old consumers.
- A definition may reference multiple commercial products when realization creates several chargeable services.
- Do not infer a provider or product from ID naming conventions.
- Provider adapters translate provider price/plan observations into approved rate cards and financial observations.
- Add a separate complete `pricingCatalogHash` and a v2 `capabilityCatalogHash` to decisions. The latter covers the full v2 resource definitions, including commercial references, so the capability-to-price binding is pinned. Do not silently alter the existing `catalogHashOf` output used by v1 receipts; introduce a separately versioned hash function.

### 11.5 Broker and budget signals

- Preserve `BillingPlane.authorize({spendEstimateUsd, billing})` for legacy callers.
- Add a v2 authorization input containing the selected quote and policy basis. Keep v2 amounts as exact decimal/scaled integers at this boundary; do not propagate CI's integer micros or broker's legacy whole-USD `number` as a universal wire type. Legacy whole-USD/micro conversions remain isolated to their adapters.
- Hard budgets use positive incremental exposure, not negative deltas or workload-allocated cost.
- New-agreement and cancellation obligations require explicit policy permission independent of budget amount.
- Reuse `budget.ThresholdCrossed`/`Recovered`; extend actual adjustment handling deliberately rather than treating credits and invoices as the same fact.

### 11.6 Events and receipts

Proposed new fact families (final names should be pinned in the ADR):

- `pricing.RateCardPublished`
- `pricing.CatalogRegistered` — a provider's whole `PricingCatalog`, appended by `hobo registry add` when a [provider manifest](./provider-manifest.md) declares billing (ADR-0177)
- `pricing.ProviderAgreementObserved`
- `pricing.GrantObserved`
- `pricing.CommitmentObserved`
- `pricing.QuoteCreated`
- `pricing.Reservation*`
- `pricing.ActualChargeObserved`
- `pricing.ReconciliationRecorded`

v2 placement/dispatch receipts include quote hash, pricing catalog hash, capability catalog hash where applicable, financial-state sequence/hash, and rating algorithm version. Sensitive commercial terms remain tenant-scoped; public receipts may carry hashes and summarized costs rather than full contracts.

## 12. Phased implementation handoff

### Phase 0 — Ratify the ADR, scope amendment, and behavior baseline

- Add the ADR and package-namespace ownership entry. Amend the FinOps scope statement to permit **offline provider-price rating for routing** while continuing to exclude customer billing, tax, payment collection, and live billing sync from the decision path.
- Create a technical proof for exact quoting and an epic proof for credit/budget-aware routing.
- Pin the decisions in Section 1, especially effective-cost views, fail-closed behavior, and no automatic provider-agreement changes.
- Before refactoring, add golden `replayInput` -> exact `dispatchEvent` fixtures and extend `packages/dispatcher/test/dispatcher.test.ts`, `reservation-ledger.test.ts`, and `placement-ranking-and-hashing.test.ts` as appropriate.
- Add characterization fixtures for CI allocation outcomes and sandbox quotes, including all current rounding, plan/region validation, and rejection behavior.

### Phase 1 — Pure schema and rating kernel

Deliver two reviewable slices rather than one large billing drop:

1. **Walking skeleton:** decimal/unit primitives (extracted from the proven CI accounting approach, not forked), product/rate-card parsing, fixed/recurring/per-unit charges, allowances, and baseline-delta quotes.
2. **Commercial completion:** package/graduated/volume charges, credits, basic commitments, allocation conventions, and basis conservation.

Add all synthetic fixtures in Section 10. Do not migrate callers in this phase.

**Exit:** deterministic golden quotes, exact boundary arithmetic, unsupported-input failures, and package contract tests pass.

### Phase 2 — Financial state and legacy adapters

- Implement `FinancialStateView` folds and provenance/freshness checks.
- Implement lossless legacy Offer/dispatcher translators. The legacy adapter floors headroom and ceils charges, emits the old JS-number shape exactly once, and never changes legacy grant array order.
- Add reservation consumption planning and CAS conformance tests. The new path consumes its deterministic priority/expiry/ID plan and restores that exact plan rather than relying on array order.

**Exit:** equivalent simple per-unit/free-allowance quotes and adapter-produced legacy views match current CI/dispatcher fixtures; richer models cannot silently lower to legacy fields.

### Phase 3 — Dispatcher v2 and CI migration

- Add quote-based ranking while freezing v1 behavior and golden replay.
- Migrate new CI routes to the shared engine; keep legacy settlement for in-flight leases.
- Add PACT boundaries for quote-based dispatch and policy observations.

**Exit:** old replay is byte-identical; new CI decisions contain complete quote evidence; no duplicate rating formula remains in the v2 path.

### Phase 4 — Cloud/broker integration

- Add commercial references, v2 receipt evidence, and BillingPlane quote authorization.
- Wire provider adapters through mocked, PACT-derived catalog/observation boundaries.

**Exit:** placement, CI, and traffic candidates use the same quote engine for equivalent products.

### Phase 5 — Reconciliation and broader models

- After the corresponding scope acceptance, add offline actual-charge/FOCUS importers, variance facts, and adjustment-aware budget folds. Live provider billing sync remains a separate adapter initiative, never a pure-rating dependency.
- Add external persisted quotes for unsupported/dynamic models.
- Consider pinned FX, additional percentage/dynamic charge kinds, and compound-scenario optimization only with separate fixtures and ADRs.

## 13. Required test and invariant matrix

| Area | Required proof |
| --- | --- |
| Decimal money | No binary-float accumulation; exact serialization; currency exponent and micro-unit compatibility; huge/overflow values rejected. |
| Rounding | Event versus period rounding; per-job ceiling; package ceiling; tier boundaries immediately below/at/above each threshold. |
| Fixed/recurring | Existing agreement not double-charged; new agreement includes correct proration; advance/arrears and due-now differ correctly. |
| Allowances | Scope, recurrence, expiry through action horizon, rollover, priority, overage versus hard block. |
| Credits | Paid/promotional basis, monetary versus unit scope, deterministic burn-down, `derivedFrom` single-basis path, basis-conservation residuals, no subscription/credit double count. |
| Commitments | Used and unused amounts at declared bucket granularity, straight-line recognition, underuse, expiry/waste tie-breaks, migration without assumed refund. |
| Allocation | `marginal-consume` order is pinned; `period-proportional` records its forecast; allocated basis never reaches the dispatcher ranker. |
| Baselines | Graduated and volume quotes use current-period baseline; negative volume delta cannot create budget headroom. |
| Multidimensional | Independent sandbox quantities and grants; missing dimension fails closed. |
| Migration | Target + source + dual-run + egress + cancellation evaluated jointly. |
| Freshness | Future, stale, conflicting, and partial observations follow explicit eligibility rules. |
| Currency | Mixed currencies rejected without pinned FX. |
| Reservations | Concurrent holds cannot double-spend; confirm/release/expire restores exact consumption once. |
| Replay | Same inputs produce byte-identical quote and decision; no network/clock dependence; v1 golden replay unchanged. |
| Governance | Observation publishers cannot change provider binding, desired policy, price authority, or budget; new agreements/cancellations default-deny. |
| Tenancy | Foreign-tenant agreements, grants, actuals, and observations are rejected. |
| Security | No credentials in commercial records; parser bounds and no executable pricing expressions. |
| Reconciliation | Duplicate actuals dedupe by provider ID; late/negative adjustments append correctly without rewriting history. |

Use unit, type, schema, consumer/provider PACT, property, and golden-replay lanes as appropriate. Do not require live paid provider APIs.

## 14. Implementation guardrails for the agent

1. Do not widen `BillingPolicy` into a product catalog. It remains enforcement policy.
2. Do not add subscription/credit fields piecemeal to `CreditAccount` or CI `Offer`; translate them into the new model.
3. Do not make dispatcher depend on CI or provider adapters.
4. Do not execute provider-supplied pricing logic.
5. Do not treat missing prices, allowances, usage, or actuals as zero.
6. Do not sum independent quotes for joint actions.
7. Do not auto-purchase or cancel commitments to improve a score.
8. Do not mix billed, effective-delta, and workload-allocated costs in one ranking field.
9. Do not change v1 hashes, persisted event bodies, or old replay output while introducing v2.
10. Do not claim live provider-price accuracy from hand-authored fixtures or PACTs.

## 15. Final recommendation

Proceed with `@hobo/pricing`, but keep the first implementation narrow: immutable rate cards, account agreements, exact baseline-delta rating, separate grants/commitments, provenance-rich financial snapshots, and quote-based dispatcher integration. The model is broad enough for subscriptions, metered use, flat fees, credits, and commitments without forcing every provider into a subscription abstraction.

The most important design choice is the **QuoteVector**. It lets HoBo answer different questions honestly:

- What additional provider charge will this action create?
- What is due immediately?
- What new obligation am I accepting?
- What recognized cost changes?
- What economic asset does this workload consume?
- What evidence and assumptions produced the answer?

That is the information a financial router needs; a single `marginalPrice` cannot provide it.

## 16. References

Repository sources are pinned to baseline commit `921ad419e76a4773e037dd33d095127e5846855b`.

- Stripe Prices API: https://docs.stripe.com/api/prices
- Stripe usage-based pricing models: https://docs.stripe.com/billing/subscriptions/usage-based-legacy/pricing-models
- Stripe Billing Credit Grants: https://docs.stripe.com/api/billing/credit-grant
- PayPal subscription pricing plans: https://developer.paypal.com/platforms/subscriptions/customize/pricing-plans
- Polar products: https://polar.sh/docs/features/products
- Polar usage-based billing: https://polar.sh/docs/features/usage-based-billing/introduction
- OpenMeter product/catalog overview: https://github.com/openmeterio/openmeter
- OpenMeter grants: https://openmeter.io/docs/billing/entitlements/grant
- Lago architecture and pricing separation: https://github.com/getlago/lago
- Lago charge object: https://getlago.com/docs/api-reference/plans/charges/object
- FOCUS Effective Cost: https://focus.finops.org/docs/specification/v1-4/columns/cost-and-usage/effective-cost/
- FOCUS commitment discounts: https://focus.finops.org/docs/specification/v1-3/sections/appendix/commitment-discounts/