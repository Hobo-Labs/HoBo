# @hobo/pricing

Pure provider-cost rating for HoBo routing and FinOps. It models provider
commercial terms only; customer billing, payments, tax, and invoices are out of
scope. The normative design is
[`docs/design/provider-pricing-commercial-terms.md`](../../docs/design/provider-pricing-commercial-terms.md)
and ADR-0176 records the package boundary.

## Batch 2 surface

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

`@hobo/pricing/legacy` exports the moved CI allocation and sandbox translators.
Their function bodies are unchanged, and `legacy_ci.proto` mirrors the two
CI-owned protobuf records with identical type names, fields, and wire numbers.
The CI package preserves its original imports through thin re-exports. The
`@hobo/ci -> @hobo/pricing` workspace edge is registered in the conformance
boundary catalog; pricing has no reverse dependency on CI.

`ExternalProviderQuote` is an evidence record, not an executable pricing model.
`external-quote.ts` always rejects attempts to turn one into a rating engine.
Dispatcher v1 is unchanged; v2 lives in `@hobo/dispatcher` as
`decideDispatchV2`. Legacy CI sandbox accounting re-exports from
`@hobo/pricing/legacy`. Broker quote authorization and cloud commercial catalog
hashes integrate without changing dispatcher v1 replay.

## Phases 2–5 surface

- **`@hobo/pricing/legacy`**: moved CI decimal accounting (`allocationQuote`,
  `divideDecimalAtMost`); `@hobo/ci` re-exports preserve import paths.
- **`decideDispatchV2`**: ranks registered providers by minimum incremental
  billed amount from `quoteScenario`; v1 `decideDispatch` is byte-identical on
  the pinned replay fixture.
- **Adversarial §13**: fixtures 10.1–10.11 (including stale observation,
  cross-currency, and zero-incremental tie cases).
- **`pricing.*` events**: pinned v1 corpus entry for `pricing.QuoteCreated` in
  `@hobo/events`.
- **Broker / cloud**: `authorizeBillingSpend` prefers quote incremental USD;
  `pricingCatalogHashFromCommercialRefs` hashes commercial product refs without
  altering resource `catalogHashOf`.

## Contracts and validation

`data-models/pricing.proto` is the canonical record source. TypeScript messages
under `src/_generated/` are generated, never hand-edited. `pricing.cue` pins
decimal syntax, UTC billing periods, exclusive groups, and derived-grant basis;
valid and invalid JSON fixtures exercise those constraints.

```bash
pnpm --filter @hobo/pricing run codegen
pnpm --filter @hobo/pricing run test:schema
pnpm --filter @hobo/pricing run test:contract:consumer
pnpm --filter @hobo/pricing run test
```

`corpus/golden-replay-baseline.json` pins a complete quote output. The replay
test parses its scenario through protobuf JSON, rerates it, and compares the
stable JSON result, including the deterministic quote hash. The quote-boundary
PACT is a hand-authored consumer expectation; no live provider accuracy is
claimed.

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
