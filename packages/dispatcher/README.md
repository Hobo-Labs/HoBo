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
  `decideDispatch` is unchanged for credit ranking.

## Dispatcher v2

`decideDispatchV2` and `@hobo/dispatcher/v2` use schema
`hobo.dispatcher/v2`. For each candidate's `QuoteScenario`, the adapter calls
`@hobo/pricing` and ranks exact `incremental.billed` decimals under the
`min-incremental-billed` objective. Provider ID breaks equal-cost ties.
Rejected, stale, partial, unpriced, or cross-currency quotes fail closed and
never fall back to list price. `DispatchCostQuote` omits the advisory
`allocatedEffective` field. V1 source and replay behavior remain untouched; a
fixed-fixture SHA-256 golden pins the complete v1 decision.

`CreditAccount.reservedCost` holds pending monetary exposure in the account's
declared currency, using the existing `budgetCap`/`listUnitCost` number units.
`reserve({ expectedSeq, reservationId, providerId, dimension, units, unitCost?,
switchingCost?, estimatedCost?, expiresAt? })` checks budget and capacity in the
same CAS operation. `estimatedCost` may raise the reservation to a quoted
all-in total; it cannot lower the modelled exposure. A caller must supply the
appropriate account and authoritative quote: missing accounts retain the
legacy unconstrained selection behavior and do not establish a budget guarantee.

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
