---
name: verify-pricing-eligibility
description: Check financial-state completeness, informational quotes, and the dispatcher v2 eligibility gate when changing pricing or routing.
---

# Pricing completeness and dispatch eligibility

**Property:** A new `pricing-rating/v9` quote from partial financial state is informational and ineligible for automatic selection; dispatcher v2 selects only quotes with explicit positive eligibility and no unpriced items.

**Why:** A partial state can omit costs. Previously a cheaper partial quote was marked eligible and selected over a complete quote, and a quote with missing eligibility metadata passed the dispatcher gate.

**Review basis:** commit `e380daf9e49f305c4513d40e2f6135cff19e49a5`. Rerun these checks against current source. The model and proof do not establish that TypeScript refines them.

## Covered code

- `packages/pricing/src/{state,quote}.ts`: completeness validation, explicit partial-showback option, versioned quote eligibility and explanation.
- `packages/dispatcher/src/{dispatcher-v2,quote-admission}.ts`: rejection of ineligible, missing-eligibility or unpriced quotes before ranking.
- `packages/pricing/test/pricing-partial-eligibility.test.ts`: complete and partial cases, v8 replay, and 200 generated unknown completeness values (seed 614492).
- `packages/dispatcher/test/dispatcher-v2-eligibility.test.ts`: a cheaper partial candidate versus a complete candidate, partial-only failure, and direct admission testing of missing eligibility metadata.
- `test/golden-replay.test.ts`, `test/section-13-coverage.test.ts`, the pricing consumer contract and dispatcher v2 tests: historical output and related decision boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-eligibility
```

The runner checks the real TypeScript with Vitest and fast-check, bounded TLC 1.7.4, an expected historical counterexample, and a Z3 4.15.4 boolean obligation. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. The dispatcher check aliases pricing imports to current source rather than a potentially stale build. Use `/statechart` to inspect counterexamples and regenerate the model projection. For isolated mutations, set `PRICING_ELIGIBILITY_PRICING_ROOT` and `PRICING_ELIGIBILITY_DISPATCHER_ROOT` to package copies.

## Scope and evidence

The real-code reproduction selects a complete provider after rejecting a cheaper partial showback; partial-only selection fails closed. A separate admission test removes eligibility metadata from a real quote and checks the gate. Explicit v8 replay retains the older eligible partial result. The pricing suite passed 196 tests, the dispatcher suite passed 266, and the consumer contract passed. Seven scratch code mutations affecting partial eligibility, unknown states, defaults, replay and the dispatcher gate fail the tests.

PricingEligibility checks 62 reachable states for complete, partial, and unknown states, optional showback, missing metadata, historical or current behavior, and quote and selection phases. It checks that current selection requires complete state and explicit eligibility. The projection hides 24 same-state steps. Three deliberate model mutations violate the invariant; an executable historical counterexample shows unsafe selection. The missing-metadata case abstracts a corrupted or incomplete quote; normal QuoteEngine output includes eligibility. The model assumes the completeness classification and quoted amounts are truthful and does not model budgets, reservations, external providers, TypeScript refinement, or every selection policy.

Z3 checks that the abstract boolean quote and selection gates imply complete state and present eligibility, with a witness for a successful complete case. `PRICING_ELIGIBILITY_PROOF_MUTATION=partial-eligible` and `ignore-missing` give counterexamples. This obligation does not authenticate provider data or establish real-code refinement.

V1–v8 replay preserves earlier partial eligibility; reconcile affected quotes and do not authorize new work solely from historical results. The broker's separate raw-estimate helper receives no quote or eligibility metadata, so its callers must enforce quote eligibility independently. This skill does not verify that helper, other consumers or the rest of HoBo.

## Keep in sync

When covered code changes, review showback and dispatch semantics, run real-code checks and the bounded model, replay counterexamples against code, exercise broken variants of both pricing and the dispatch gate, regenerate the projection, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
