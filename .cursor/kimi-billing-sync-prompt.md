Implement Phase 5 live provider billing sync for @hobo/pricing in repo /agent/repos/HoBo/.hobo/worktrees/pricing-signed.

Constraints:
- Separate from pure rating: new code under packages/pricing/src/sync/ only. Do NOT import sync from quote.ts, rating.ts, or packages/pricing/src/index.ts main barrel.
- Add package.json export "./sync" pointing to dist/sync/index.js (update exports block).
- Fail closed on incomplete data (partial FOCUS rows, missing fields, mixed currency).
- Dated snapshots: schema hobo.pricing.billing-sync.snapshot/v1 with syncAt, snapshotHash (use stableHash from ../json.js), period, completeness.
- Dedupe actuals by provider charge id (ActualCharge.id).
- Emit variance facts (billed vs quoted) and ReconciliationRecorded protobuf via create() from _generated/pricing_pb.js.
- Provider port interface + fixture-backed fake port; NO real HTTP. Credentials type only; tests generate synthetic Bearer at runtime via crypto.randomUUID(), never write secrets to disk.
- Map FOCUS-shaped rows to ActualCharge (agreement_id, billed_cost Money with parseDecimal from ../decimal.js).

Create:
1. packages/pricing/src/sync/provider-port.ts - ProviderBillingPort, FocusBillingRow, synthetic credentials type
2. packages/pricing/src/sync/focus-import.ts - importFocusRow, rejects incomplete
3. packages/pricing/src/sync/billing-sync.ts - runBillingSync, BillingSyncSnapshot, VarianceFact, fixtureProviderPort(readFileSync fixture)
4. packages/pricing/src/sync/index.ts - re-exports
5. packages/pricing/test/fixtures/focus-provider-billing.json - complete rows + one partial row for fail-closed test
6. packages/pricing/test/billing-sync.test.ts - tests including:
   - "§12 Phase 5 live billing sync produces dated snapshot and variance against quote"
   - "§12 Phase 5 fails closed on incomplete provider billing data"
   - "§12 Phase 5 dedupes provider charge ids and appends reconciliation hash"
   - duplicate id suppression, negative adjustment row
7. packages/pricing/contracts/pacts/provider-billing-sync.pact.json - POST /pricing/v1/billing-sync mock interaction
8. packages/pricing/contracts/consumer/billing-sync-boundary.test.ts - "meets the billing sync PACT boundary"

Update packages/pricing/test/design-scorecard-eval.test.ts:
- Remove deferred-only test block
- Add assertion that no row has status deferred or partial

Update docs/design/provider-pricing-scorecard.md row §12.5 to pass with evidence_file packages/pricing/test/billing-sync.test.ts and evidence_test matching one of the §12 Phase 5 test names above.

Match existing code style (PricingFault codes as strings in sync rejections, biome, no .mjs in src except design-scorecard.mts pattern - use .ts in sync/).

Do not modify quote.ts or rating.ts.
