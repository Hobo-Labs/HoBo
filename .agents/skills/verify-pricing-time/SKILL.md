---
name: verify-pricing-time
description: Check UTC validity, interval coverage, time ordering, and historical rating replay in the pricing kernel.
---

# Pricing time validity and ordering

**Property:** New `pricing-rating/v6` quotes reject invalid calendar timestamps and future or insufficient evidence at exact UTC precision, and choose credit expiries, rate-card starts, and latest observations by instant.

**Why:** Text comparison and millisecond truncation can select a later-expiring credit or accept evidence that is not yet valid. Before this fix, an expiry at `.5Z` sorted before the same second at `Z`, and evidence beginning at `.0002Z` covered a request at `.0001Z`.

**Review basis:** commit `f25e6b7cab6f033db041b344fee2eb7aa89ee88a`. Run the checks on current source before relying on the result. The models and proof do not establish TypeScript refinement.

## Covered code

- `packages/pricing/src/{state,catalog,rating,quote}.ts`: UTC parsing, evidence and interval checks, expiry, rate-card and latest-observation ordering, and version selection.
- `packages/pricing/test/pricing-utc-order.test.ts`: real-code boundary, replay, and generated fractional and interval checks.
- `packages/pricing/test/golden-replay.test.ts`, `test/pricing-locale.test.ts`, and `contracts/consumer/quote-boundary.test.ts`: pinned old-version replay and related boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-time
```

The runner checks real TypeScript with Vitest and fast-check, bounded TLC 1.7.4, an expected legacy counterexample, and a Z3 4.15.4 interval obligation. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. Use `/statechart` to inspect counterexamples and regenerate the projection from the model and view. For a deliberate scratch mutation, set `PRICING_VERIFY_PACKAGE_ROOT` to an isolated package copy containing its tests, fixtures, contracts, and corpus.

## Scope and evidence

The real-code tests check fractional expiry and rate-card order, a single invalid latest observation, sub-millisecond future state and stale evidence, impossible calendar dates, and explicit v2 replay. Two generated properties compare 300 fractional timestamp pairs and 300 interval cases with integer oracles (seeds 614483 and 614484). The v1–v5 golden replay corpora and consumer contract pass. The pricing suite passed 168 tests, and the downstream dispatcher suite passed 263. Nine scratch code mutations that weaken fraction, calendar, interval, horizon, expiry, latest-observation, rate-card, or legacy checks fail the tests.

PricingTime explores 256 states for two versions, a calendar-validity flag, four binary instants in one abstract millisecond, and evidence and expiry checks in either order. It checks current-version coverage and expiry order. Its projection hides 64 same-state steps. Two model mutations violate those properties; an executable expected counterexample shows that old versions can accept invalid coverage. Its current-version label abstracts v3 through v6, which use the same exact-time policy. The model assumes its instant and calendar classifications are correct and does not model the full quote engine or every timestamp.

Z3 proves that a covering abstract integer interval covers every contained subinterval, for unbounded integer instants. Its premises have a witness; `PRICING_TIME_PROOF_MUTATION=omit-end` produces a counterexample. The obligation assumes exact comparisons and does not prove string parsing, calendar validity, TypeScript refinement, or external evidence authenticity.

Explicit v1 and v2 replay preserves earlier text ordering and millisecond validation; reconcile affected historical quotes and preserve their original output. `parseUtc` returns a JavaScript millisecond number even though `compareUtcExact` retains fractional ordering. This skill does not prove external provider clocks, all pricing behavior, or the rest of HoBo.

## Keep in sync

Review intended timestamp semantics and version compatibility, run the real-code checks and bounded model, replay counterexamples against code, exercise broken variants, regenerate the chart, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
