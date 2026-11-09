# Provider pricing acceptance scorecard

Tracks acceptance of [`provider-pricing-commercial-terms.md`](./provider-pricing-commercial-terms.md) on branch `cursor/hobo-pricing-81a7`. The CI eval in `packages/pricing/test/design-scorecard-eval.test.ts` parses the table below: every row must be `pass` with evidence; `partial`, `fail`, and `deferred` block merge.

Each `pass` row is checked statically, without spawning another test runner. The evidence file must exist and its nearest `package.json` must declare `test: "vitest run"`. Because these packages use Vitest's default includes, the file must be under that package's `test/` or `contracts/` directory and have a default `.test`/`.spec` TypeScript or JavaScript suffix. TypeScript AST analysis verifies that an enabled `it`/`test` declaration matches the evidence pattern against the full name, including enclosing `describe` titles, and honors `.skip`, `.todo`, and `.only` selection. The owning package's test task still executes the evidence test behavior in the same gate.

| id | status | evidence_file | evidence_test |
| --- | --- | --- | --- |
| §1.1 | pass | packages/pricing/test/adversarial-10.test.ts | 10.1 rates only usage beyond the existing 950/1000 minutes |
| §1.2 | pass | packages/pricing/test/adversarial-10.test.ts | 10.1 rates only usage beyond the existing 950/1000 minutes |
| §1.3 | pass | packages/pricing/test/adversarial-10.test.ts | 10.2 distinguishes paid-credit basis from promotional credit |
| §1.4 | pass | packages/pricing/test/section-13-invariants.test.ts | denies new provider agreements unless explicitly allowed |
| §1.5 | pass | packages/pricing/test/adversarial-10.test.ts | 10.8 rejects observations that do not cover the quote horizon |
| §1.6 | pass | packages/pricing/test/decimal-money.test.ts | parseDecimal rejects non-canonical wire decimals |
| §1.7 | pass | packages/pricing/test/golden-replay.test.ts | replays every pinned scenario to its exact quote and hash |
| §1.8 | pass | packages/pricing/test/section-13-invariants.test.ts | documents customer billing tax and invoices out of scope |
| §14.1 | pass | packages/broker/test/pricing-authorization.test.ts | prefers quote incremental over legacy spend estimate |
| §14.2 | pass | packages/pricing/test/section-13-invariants.test.ts | legacy CI translators remain separate from CreditAccount fields |
| §14.3 | pass | packages/dispatcher/test/dispatcher-v2.test.ts | ranks exact incremental billed decimals and removes advisory allocation |
| §14.4 | pass | packages/pricing/test/section-13-invariants.test.ts | external persisted quotes never become executable rating |
| §14.5 | pass | packages/dispatcher/test/dispatcher-v2.test.ts | fails closed instead of treating rejected pricing as zero |
| §14.6 | pass | packages/pricing/test/adversarial-10.test.ts | 10.10 prices joint non-additive actions once instead of summing independent deltas |
| §14.7 | pass | packages/pricing/test/section-13-invariants.test.ts | denies cancellation unless explicitly allowed |
| §14.8 | pass | packages/dispatcher/test/dispatcher-v2.test.ts | ranks exact incremental billed decimals and removes advisory allocation |
| §14.9 | pass | packages/dispatcher/test/dispatcher-v1-byte-identical.test.ts | keeps the complete fixed-fixture decision byte-identical |
| §14.10 | pass | packages/pricing/contracts/consumer/quote-boundary.test.ts | meets the hand-authored QuoteVector expectation |
| §13.decimal | pass | packages/pricing/test/decimal-money.test.ts | parseDecimal rejects non-canonical wire decimals |
| §13.rounding | pass | packages/pricing/test/section-13-coverage.test.ts | §13 package rounding uses ceiling on package charges |
| §13.fixed-recurring | pass | packages/pricing/test/adversarial-10.test.ts | 10.1 rates only usage beyond the existing 950/1000 minutes |
| §13.allowances | pass | packages/pricing/test/adversarial-10.test.ts | 10.7 enforces a free plan hard limit without billing overage |
| §13.credits | pass | packages/pricing/test/adversarial-10.test.ts | 10.2 distinguishes paid-credit basis from promotional credit |
| §13.commitments | pass | packages/pricing/test/adversarial-10.test.ts | 10.3 consumes a $100 commitment with $40 used and $30 candidate |
| §13.allocation | pass | packages/pricing/test/section-13-coverage.test.ts | §13 allocation exposes advisory allocatedEffective separate from incremental effective |
| §13.baselines | pass | packages/pricing/test/adversarial-10.test.ts | 10.10 prices joint non-additive actions once instead of summing independent deltas |
| §13.multidimensional | pass | packages/pricing/test/adversarial-10.test.ts | 10.5 rates a multidimensional sandbox composite independently |
| §13.migration | pass | packages/pricing/test/adversarial-10.test.ts | 10.6 rates migration source removal and target addition jointly |
| §13.freshness | pass | packages/pricing/test/adversarial-10.test.ts | 10.8 rejects observations that do not cover the quote horizon |
| §13.currency | pass | packages/pricing/test/adversarial-10.test.ts | 10.9 refuses to rank or sum mixed currencies |
| §13.reservations | pass | packages/dispatcher/test/reservation-ledger.test.ts | restores exactly the headroom the reservation consumed |
| §13.replay | pass | packages/dispatcher/test/dispatcher-v1-byte-identical.test.ts | keeps the complete fixed-fixture decision byte-identical |
| §13.governance | pass | packages/pricing/test/section-13-invariants.test.ts | denies new provider agreements unless explicitly allowed |
| §13.tenancy | pass | packages/pricing/test/state-tenancy.test.ts | rejects agreements whose tenantId differs from financial state |
| §13.security | pass | packages/broker/test/pricing-authorization.test.ts | rejects negative quote incremental decimal |
| §13.reconciliation | pass | packages/pricing/test/section-13-coverage.test.ts | §13 reconciliation dedupes provider ids via billing sync |
| §10.1 | pass | packages/pricing/test/adversarial-10.test.ts | 10.1 rates only usage beyond the existing 950/1000 minutes |
| §10.2 | pass | packages/pricing/test/adversarial-10.test.ts | 10.2 distinguishes paid-credit basis from promotional credit |
| §10.3 | pass | packages/pricing/test/adversarial-10.test.ts | 10.3 consumes a $100 commitment with $40 used and $30 candidate |
| §10.4 | pass | packages/pricing/test/adversarial-10.test.ts | 10.4 keeps graduated and volume tiers distinct for 90 + 20 units |
| §10.5 | pass | packages/pricing/test/adversarial-10.test.ts | 10.5 rates a multidimensional sandbox composite independently |
| §10.6 | pass | packages/pricing/test/adversarial-10.test.ts | 10.6 rates migration source removal and target addition jointly |
| §10.7 | pass | packages/pricing/test/adversarial-10.test.ts | 10.7 enforces a free plan hard limit without billing overage |
| §10.8 | pass | packages/pricing/test/adversarial-10.test.ts | 10.8 rejects observations that do not cover the quote horizon |
| §10.9 | pass | packages/pricing/test/adversarial-10.test.ts | 10.9 refuses to rank or sum mixed currencies |
| §10.10 | pass | packages/pricing/test/adversarial-10.test.ts | 10.10 prices joint non-additive actions once instead of summing independent deltas |
| §10.11 | pass | packages/dispatcher/test/dispatcher-v2-tiebreak.test.ts | 10.11 prefers sooner projected waste expiry among zero incremental ties |
| §12.0 | pass | packages/pricing/test/section-13-invariants.test.ts | phase 0 ADR scope and offline provider-price rating boundary |
| §12.1 | pass | packages/pricing/test/golden-replay.test.ts | replays every pinned scenario to its exact quote and hash |
| §12.2 | pass | packages/pricing/contracts/consumer/quote-boundary.test.ts | meets the hand-authored QuoteVector expectation |
| §12.3 | pass | packages/dispatcher/test/dispatcher-v1-byte-identical.test.ts | keeps the complete fixed-fixture decision byte-identical |
| §12.4 | pass | packages/broker/test/pricing-authorization.test.ts | prefers quote incremental over legacy spend estimate |
| §12.5 | pass | packages/pricing/test/billing-sync.test.ts | §12 Phase 5 live billing sync produces dated snapshot and variance against quote |
