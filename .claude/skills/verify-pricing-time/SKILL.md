---
name: verify-pricing-time
description: Check UTC validity, interval coverage, time ordering, and latest-observation selection in the pricing kernel.
---

# Pricing time validity and ordering

**Property:** Quotes reject invalid calendar timestamps and future or insufficient evidence at exact UTC precision, and choose credit expiries, rate-card starts, and latest observations by instant. Conflicting values at the same latest instant reject rather than depend on input order.

**Why:** Text comparison and millisecond truncation can select a later-expiring credit or accept evidence that is not yet valid. An expiry at `.5Z` sorted before the same second at `Z`, and evidence beginning at `.0002Z` covered a request at `.0001Z`.

**Review basis:** commit `e9c20aea41e67c779a47d169e25de38ce28552fa`. Run the checks on current source before relying on the result. The models and proof do not establish TypeScript refinement.

## Covered code

- `packages/pricing/src/{state,catalog,rating,quote,time-order}.ts`: UTC parsing, evidence and interval checks, expiry, rate-card and latest-observation ordering.
- `packages/pricing/test/pricing-utc-order.test.ts`: real-code boundary and generated fractional and interval checks.
- `packages/pricing/test/pricing-latest-ties.test.ts`: conflicting and equal latest values, equivalent timestamps and units, older conflicts, baseline rejection, and 300 generated fractional ties (seed 614489).
- `packages/pricing/test/golden-replay.test.ts`, `test/pricing-locale.test.ts`, and `contracts/consumer/quote-boundary.test.ts`: the pinned golden corpus and related boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-time
```

The runner checks real TypeScript with Vitest and fast-check, bounded TLC 1.7.4 models, expected counterexamples for weakened models, and Z3 4.15.4 interval and latest-selection obligations. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. Use `/statechart` to inspect counterexamples and regenerate the projection from the model and view. For a deliberate scratch mutation, set `PRICING_VERIFY_PACKAGE_ROOT` to an isolated package copy containing its tests, fixtures, contracts, and corpus.

## Scope and evidence

The real-code tests check fractional expiry and rate-card order, a single invalid latest observation, sub-millisecond future state and stale evidence, and impossible calendar dates. Two generated properties compare 300 fractional timestamp pairs and 300 interval cases with integer oracles (seeds 614483 and 614484). The golden corpus and consumer contract pass.

PricingTime explores 128 distinct states for a calendar-validity flag, four binary instants in one abstract millisecond, and evidence and expiry checks in either order. It checks coverage and expiry order. Disabling the coverage check or ordering by text instead of instant violates the corresponding property. The model assumes its instant and calendar classifications are correct and does not model the full quote engine or every timestamp.

PricingLatestTie checks 32 distinct states for two observations, two abstract instants and values, and both input orders. It checks that accepted values agree across order and that a conflicting tie is rejected. Removing the conflict check violates both properties. It assumes exact instant comparisons and already-converted quantities and does not model parsing, rounding or more than two observations.

Z3 proves that selecting the maximum of arbitrary integer instants gives the same exact-real value in either order when equal instants have equal values. Premises have a witness; `PRICING_LATEST_PROOF_MUTATION=allow-conflict` gives a counterexample. This is an abstract proof, not TypeScript refinement or evidence authenticity.

Z3 proves that a covering abstract integer interval covers every contained subinterval, for unbounded integer instants. Its premises have a witness; `PRICING_TIME_PROOF_MUTATION=omit-end` produces a counterexample. The obligation assumes exact comparisons and does not prove string parsing, calendar validity, TypeScript refinement, or external evidence authenticity.

`parseUtc` returns a JavaScript millisecond number even though `compareUtcExact` retains fractional ordering. This skill does not prove external provider clocks, all pricing behavior, or the rest of HoBo.

## Keep in sync

Review intended timestamp semantics, run the real-code checks and bounded models, replay counterexamples against code, exercise broken variants, regenerate the chart, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
