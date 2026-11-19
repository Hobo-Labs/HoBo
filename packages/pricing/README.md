# @hobo/pricing

Pure provider-cost rating for HoBo routing and FinOps. It models provider
commercial terms only; customer billing, payments, tax, and invoices are out of
scope.

## Quote engine

`QuoteEngine.quote(scenario)` (also available as `quoteScenario(scenario)`)
accepts the generated `QuoteScenario` protobuf type and returns
`QuoteVector | PricingRejected`. It rates fixed and usage charges, allowances,
paid/promotional credits, and provider-actual spend commitments. Baseline and
candidate snapshots use the same pinned state; incremental amounts are
`F(baseline + candidate) - F(baseline)`.

- Exact decimal strings and scaled-integer arithmetic; no floating-point money.
- Explicit unit identities/conversions; GB and GiB are never treated as aliases.
- Complete, current evidence is required through the quote horizon.
- Exclusive charge groups, currency mismatches, stale observations, unknown
  terms, and unsupported external rating fail closed.
- Credits sort by priority, earliest expiry, then grant ID. Derived credits have
  zero additional economic basis; purchased-credit basis is allocated pro rata.
- Upfront provider-actual commitments support billing-period and single-UTC-hour
  buckets; cross-hour consumption fails closed.
- No wall clock, network, environment, locale, or live provider calls.
- New agreements and cancellation are denied unless explicitly enabled.

`allocationQuote` and `divideDecimalAtMost` provide exact allocation
arithmetic for CI routing.

`ExternalProviderQuote` is an evidence record, not an executable pricing model.
`external-quote.ts` always rejects attempts to turn one into a rating engine.
`@hobo/dispatcher` ranks pricing quotes with `decidePricedDispatch`. CI sandbox
accounting is available from `@hobo/ci`.

## Integrations

- **Allocation arithmetic**: `allocationQuote` and `divideDecimalAtMost`
  calculate reserved and paid runner usage.
- **`decidePricedDispatch`**: ranks registered providers by minimum incremental
  billed amount from `quoteScenario`.
- **Adversarial §13**: fixtures 10.1–10.11 (including stale observation,
  cross-currency, and zero-incremental tie cases).
- **`pricing.*` events**: pinned v1 corpus entry for `pricing.QuoteCreated` in
  `@hobo/events`.
- **Broker / cloud**: `authorizeBillingSpend` prefers quote incremental USD;
  `pricingCatalogHashFromCommercialRefs` hashes commercial product refs without
  altering resource `catalogHashOf`.
- **`@hobo/pricing/sync`**: offline provider billing sync adapter.
  Imports FOCUS-shaped rows through a `ProviderBillingPort`, dedupes by provider
  charge id, emits dated `hobo.pricing.billing-sync.snapshot/v1` snapshots,
  variance facts, and `ReconciliationRecorded` events. Missing fields, partial
  rows, invalid dates, and mixed quote/provider currencies are rejected. The
  adapter is independent of the pure quote kernel.

Pass previously recorded charges for the same reservation and billing period as
`knownActualCharges`. Reconciliation compares their total plus newly imported
charges with the quote, emits only new charges, and rejects a reused provider
charge ID when its contents differ.
Provider charge periods must fall inside the requested billing period.

The reconciliation hash is `stableHash` of the event ID,
occurrence time, reservation ID, and ordered actual charges as
protobuf JSON with implicit fields emitted. Charges are ordered by provider
charge ID. The snapshot hash covers every
snapshot field except the hash itself, with imported charges in the same JSON
form. `stableHash` sorts object keys before hashing the JSON bytes.

## Contracts and validation

`data-models/pricing.proto` is the canonical record source. TypeScript messages
under `src/_generated/` are generated, never hand-edited. `pricing.cue` pins
decimal syntax, UTC billing periods, exclusive groups, and derived-grant basis;
valid and invalid JSON fixtures exercise those constraints.

```bash
pnpm --filter @hobo/pricing run codegen
pnpm --filter @hobo/pricing run test:schema
pnpm --filter @hobo/pricing run test:contract:consumer
pnpm --filter @hobo/pricing run test:contract:provider
pnpm --filter @hobo/pricing run test
```

`corpus/golden-replay-baseline.json` pins a complete quote output. The replay
test parses its scenario through protobuf JSON, rerates it, and compares the
stable JSON result, including the deterministic quote hash. The quote-boundary
PACT is an in-process consumer expectation verified against the pricing kernel
and consumed by `@hobo/dispatcher`. It does not establish live provider accuracy.

## Architecture boundaries

Parse, don't validate starts at `parseJson` and `parseQuoteScenario`: untrusted
JSON becomes a generated `QuoteScenario` before rating. `parseDecimal` derives
the scaled-integer `Decimal` parsed type, and rating functions accept generated
messages plus these derived domain types rather than raw DTOs.

The quote kernel remains a pure query, so it has no command handler, actor,
event-store write, materialized view projection, persisted snapshot, or read store.
`rateSnapshot` builds only an ephemeral rating snapshot and never mutates a read
model. The declared `pricing.*` events belong to later actor integrations; those
integrations must consume commands, append events to an event store, and build
materialized-view projections and snapshots in a read store outside this pure
rating path.
