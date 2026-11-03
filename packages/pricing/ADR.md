# ADR: @hobo/pricing — deterministic provider-cost quotes over financial state

## Status

Accepted.

## Context

Routing and FinOps need auditable provider-cost comparisons, not customer
billing, payment, tax, or invoice behavior. Quotes must replay from pinned
commercial terms and observed financial state without live provider calls,
floating-point money, implicit unit conversions, or missing evidence being
treated as free. ADR-0176 and
`docs/design/provider-pricing-commercial-terms.md` define the product boundary;
this record pins the package's contract and state architecture.

## Decision

1. **Pure quote kernel.** `quoteScenario` rates a baseline and candidate against
   the same catalog and `FinancialStateView`, returning a generated
   `QuoteVector` or structured `PricingRejected`. Incremental cost is
   `F(baseline + candidate) - F(baseline)`. The kernel performs no network,
   environment, locale, wall-clock, event-store, or read-store I/O.
2. **Executable PACT boundary.** The hand-authored consumer expectation in
   `contracts/pacts/pricing-quote.pact.json` covers `POST /pricing/v1/quote` and
   is exercised by `contracts/consumer/quote-boundary.test.ts`. It pins the
   request/response boundary; it is not a claim of live provider verification or
   provider-price accuracy.
3. **Protobuf records with CUE invariants.** `data-models/pricing.proto` is the
   canonical source for money, quantities, commercial terms, scenarios, quotes,
   reservations, events, and financial state. Runtime messages come from the
   generated `src/_generated/pricing_pb.ts`. `data-models/pricing.cue` constrains
   every protobuf message, including exact-decimal syntax, UTC periods,
   exclusive charge groups, and zero derived-grant basis. The valid and invalid
   fixtures under `data-models/fixtures/` exercise those constraints.
4. **Parse, don't validate at the boundary.** The derived types vocabulary is
   `ParsedMoney`, `ParsedQuantity`, `ParsedDecimal`, `ParsedQuoteScenario`, and
   `ParsedFinancialStateView`: constrained domain views of generated protobuf
   records, not parallel wire declarations. `src/types.ts` owns derived result
   and domain types plus narrowing guards; `src/json.ts` owns protobuf-JSON
   parsers, canonical JSON, and stable hashes. Batch 1 currently exposes
   `QuoteResult` and `PricingRejectionCode`, while `parseQuoteScenario` and
   `quoteResultFromJson` reject malformed wire input before rating. The named
   `Parsed*` views are the derived-type boundary as richer constrained values
   are introduced; rating must not pass unchecked DTO primitives alongside
   repeated boolean checks.
5. **Integrators own commands and events.** The v1 kernel has no commands: a
   quote is a pure function and does not append events or mutate state.
   Integrating actors own any command handling, event-store writes, reservation
   lifecycle, and provider observation ingestion. After invoking the kernel,
   integrators may emit the versioned `pricing.*` events declared in protobuf:
   `pricing.RateCardPublished`, `pricing.ProviderAgreementObserved`,
   `pricing.GrantObserved`, `pricing.CommitmentObserved`,
   `pricing.QuoteCreated`, `pricing.ReservationCreated`,
   `pricing.ReservationConfirmed`, `pricing.ReservationReleased`,
   `pricing.ReservationExpired`, `pricing.ActualChargeObserved`, and
   `pricing.ReconciliationRecorded`. In particular, `QuoteCreated` records the
   scenario and resulting vector; reservation and actual-charge events are
   integrator facts, not side effects of `quoteScenario`.
6. **FinancialStateView is a rebuildable materialized view.** An integrator
   projection folds the `pricing.*` event stream from its event store into
   `FinancialStateView`, advancing `seq`, `asOf`, observations, agreement,
   allowance, credit, commitment, and actual-charge state deterministically.
   Cached snapshots serve current quote reads; historical snapshots and the
   materialized current view persist in the integrator's read store. Replay
   rebuilds the projection and snapshots, and every quote pins the catalog and
   state hashes so later replay cannot substitute newer financial state.

## Consequences

- Batch 1 can be tested and replayed without infrastructure; event persistence
  and projection hosting remain integration concerns rather than hidden kernel
  dependencies.
- Provider terms and observed state are explicit, content-addressed inputs, so
  stale or incomplete evidence fails closed and deterministic quote hashes are
  auditable.
- Adding an actor, event-store adapter, or read-store adapter does not change
  the quote boundary. Dispatcher integration remains a separate batch.
