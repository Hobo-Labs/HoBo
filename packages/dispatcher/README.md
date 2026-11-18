# @hobo/dispatcher

The Dispatcher (ADR-0071): deterministic, credit/budget-aware selection across
registered providers for placement (`match.Decided`), dispatch
(`dispatch.Decided`), and traffic (`traffic-backend` category — consumed by the
stations routing control loop).

- Ranks candidates by effective marginal cost against a pinned
  `CreditLedgerView@seq` (free tiers, rate/concurrency headroom, budget caps,
  switching cost, soonest-expiring credits).
- Hard budgets and declared rate/concurrency limits remove candidates from
  eligibility. When every candidate is ineligible, no decision fact is emitted.
  Invalid facts cannot erase an explicit hard budget.
- Hysteresis requires both a savings margin and challenger-bound continuous
  evidence (`challengerProviderId`, `savingsSince`, `observedAt`) covering the
  ISO duration `dwellWindow`. Missing evidence holds an eligible incumbent;
  an ineligible incumbent cannot be held.
- Reservation ledger with CAS (`expectedSeq`) so concurrent dispatches cannot
  double-spend free headroom; reserve/confirm/release/expire emit
  `dispatch.Reservation*` facts.
- `replayDispatchDecision` replays identical inputs to a byte-identical
  decision fact.
- **`decideDispatchV2`** (schema `hobo.dispatcher/v2`) ranks registered providers
  by minimum incremental **billed** amount from `@hobo/pricing` quotes; v1
  `decideDispatch` continues to use credit ranking.

## Dispatcher v2

`decideDispatchV2` and `@hobo/dispatcher/v2` use schema
`hobo.dispatcher/v2`. For each candidate's `QuoteScenario`, the adapter calls
`@hobo/pricing` and ranks exact `incremental.billed` decimals under the
`min-incremental-billed` objective. Provider ID breaks equal-cost ties.
Rejected, stale, partial, unpriced, or cross-currency quotes fail closed and
never fall back to list price. `DispatchCostQuote` omits the advisory
`allocatedEffective` field. A fixed-fixture SHA-256 golden pins an existing v1 decision; the numeric safety corrections below can change v1 decisions for edge cases.

Overflowing available balances are capped at the largest finite number;
reservations or settlements that cannot be represented leave the ledger and
existing holds unchanged.

Candidates may instead supply `pricing: pricingUnavailable(reason)` or
`pricing: developerPricing(scope, scenario)` from `@hobo/pricing`.
Unavailable pricing is rejected with `PRICING_MODEL_UNAVAILABLE`; supplied
terms are checked against the candidate provider, tenant, account and product,
and their model ID and revision accompany the ranked quote and decision fact.
The checks cover the supplied scenario, not an independently verified IaC
inventory. The v2 dispatcher ranks estimates; it does **not** apply a budget,
reserve funds or authorize a provider call. Every v2 success and rejection
reports `budget: { evaluation: "not-evaluated", reservation: "not-created" }`;
successful `dispatch.Decided` facts carry the same disclosure. Budgeted hosting still needs the
broker's trusted whole-request quote, bound, policy decision and durable hold.

`rankIacTargets` ranks whole-target assessments for one tenant, workload,
action and quote interval. It returns excluded targets and `coverage: "partial"`
when any cannot be compared or priced. Its budget disclosure says no budget
was evaluated and no reservation created; use the broker admission authority
before executing the chosen target. The caller must establish that its common
workload reference identifies equivalent work across candidates.

Ranking accepts at most 256 candidates. Before copying their inventories and
models it bounds the whole batch to 100,000 data nodes and 4,000,000 UTF-16
code units of string values and property names; repeated references count each
time. Each inventory and model also has its own pricing input limit.
Uninspectable or excessive inputs return `ROUTING_INPUT_INVALID` with no budget
evaluation or reservation; inspectable invalid models are reported alongside
the remaining comparable candidates. JavaScript must enumerate object keys
before counting them, which can allocate before these limits apply. The host
must impose independent process memory and time limits for untrusted input.

`executeRankedIacTargets` accepts that ranking and an execution callback for
each ranked target. It passes the same request ID and that target's inventory,
model and quote hashes to every callback, and tries
the next target only after an explicit denial with no reservation. A replay,
lost response, malformed receipt or uncertain reservation stops the route.
The result lists every attempt and its budget disclosure. A contradictory
denial stops routing. If a matching admission proves a reservation is held but
the provider cannot return usable outputs, the result remains uncertain and
reports that hold; it also reports a completed execution when the provider can
establish one. Callbacks must use
the request ID with the same durable budget authority so a retry cannot claim
another target under a different reservation. They must pass the expected
hashes into admission and check the resulting receipt before any provider
effect; checking only after the callback returns is too late.

`CreditAccount.reservedCost` holds pending monetary exposure in the account's
declared currency, using the existing `budgetCap`/`listUnitCost` number units.
`reserve({ expectedSeq, reservationId, providerId, dimension, units, unitCost?,
switchingCost?, estimatedCost?, expiresAt? })` checks budget and capacity in the
same CAS operation. `estimatedCost` may raise the reservation to a quoted
all-in total; it cannot lower the modelled exposure. A caller must supply the
appropriate account and authoritative quote, including the unit price when it differs from the account list price: missing accounts retain the
legacy unconstrained selection behavior and do not establish a budget guarantee.
The combined selection-and-reservation helper uses the account price for both
steps when present, falling back to the registry price.

Pending reservations debit free allowance and rate headroom, occupy one
concurrency slot, and hold paid exposure. `release` restores those quantities
once for never-started work. `start({ reservationId, committedSeq? })` marks the
hold running; its fact must commit durably **before** an external call or
outbox dispatch. A supervisor may expire a pending hold only after establishing
the execution outbox was not dispatched or has been fenced. A running hold
survives actor leases, timeout sweeps and cancellation requests; those requests
do not prove provider work stopped or billing finalized.

`confirm({ reservationId, actualCost?, providerUsageSeq?, usageFinalized?, usageEvidenceRef? })` settles cost
(defaulting to the estimate), releases concurrency and monetary holds, and keeps
used allowance/rate consumed. Actual overruns are recorded truthfully and
returned as `budgetExceeded`; confirmation never invents a refund to stay under
a cap. Importers must reconcile `providerUsageSeq` rather than charging the same
settlement again. This package is an in-memory aggregate; callers own durable
single-writer fencing, quote authority, execution start/termination and usage
reconciliation. Running work requires explicit `actualCost`,
`usageFinalized: true`, and an auditable `usageEvidenceRef`; unresolved billing retains the entire hold. Positive
provider cancellation/absence and final usage evidence are the caller's
authority to settle a running operation, including an actual cost of zero.

Reservation IDs are unique. Identical pending reserve retries return the
original commitment without another debit; changed payloads fail. Terminal or
expired IDs cannot authorize new work. The dispatch-and-reserve helper persists
its replay input in the reservation, so a retry retains the original winner.

`freeHeadroom`, when present, is the aggregate cap; `credits` are its grant
breakdown, not additional copies of the allowance. Without an aggregate the
grant balances are summed. Expiring grants require pinned `ledger.asOf` and
are consumed earliest-expiry first. `expire({ now })` advances that pinned time
monotonically through `dispatch.LedgerTimeAdvanced` before expiring holds;
release never makes an expired grant eligible again. Expiry only releases a
reservation: execution owners must stop or fence work before returning its
remaining financial exposure to the pool.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for evidence and
[`contracts/`](./contracts) for the v1 and v2 PACT boundaries.

## Budget verification

The [budget-policy routing skill](../../.agents/skills/verify-budget-policy-routing/SKILL.md) describes generated reservation histories, the bounded TLA+ model, and an exact-arithmetic proof of an abstract budget invariant. The legacy number contract is interpreted as decimal values; liabilities round upward and available balances downward when conversion back to numbers requires it. This protects the budget conservatively but can leave tiny residual holds or reject an edge-case request that is exactly affordable in decimal arithmetic. Provider overruns are recorded, and callers remain responsible for authoritative quotes and fencing.

Run `bash scripts/verify-state-machine.sh .agents/skills/verify-budget-policy-routing` from the repository root. It includes the hard-budget and overflow regression suites and checks weakened models for counterexamples. The skill also documents a separate scratch-mutation command for the overflow and estimate guards. The abstract proof does not establish that the TypeScript implementation refines it or model numeric overflow.
