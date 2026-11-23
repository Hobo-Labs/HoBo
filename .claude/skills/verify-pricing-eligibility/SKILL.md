---
name: verify-pricing-eligibility
description: Check financial-state completeness, informational quotes, and the dispatcher v2 eligibility gate when changing pricing or routing.
---

# Pricing completeness and dispatch eligibility

**Property:** A quote from partial financial state is informational and ineligible for automatic selection; dispatcher v2 selects only quotes with explicit positive eligibility and no unpriced items.

**Why:** A partial state can omit costs. A cheaper partial quote marked eligible would be selected over a complete quote, and a quote with missing eligibility metadata could pass the dispatcher gate.

**Review basis:** commit `e9c20aea41e67c779a47d169e25de38ce28552fa`. Rerun these checks against current source. The model and proof do not establish that TypeScript refines them.

## Covered code

- `packages/pricing/src/{state,quote}.ts`: completeness validation, explicit partial-showback option, quote eligibility and explanation.
- `packages/dispatcher/src/{dispatcher-v2,quote-admission}.ts`: rejection of ineligible, missing-eligibility or unpriced quotes before ranking.
- `packages/pricing/test/pricing-partial-eligibility.test.ts`: complete and partial cases and 200 generated unknown completeness values (seed 614492).
- `packages/dispatcher/test/dispatcher-v2-eligibility.test.ts`: a cheaper partial candidate versus a complete candidate, partial-only failure, and direct admission testing of missing eligibility metadata.
- `test/golden-replay.test.ts`, `test/section-13-coverage.test.ts`, the pricing consumer contract and dispatcher v2 tests: the pinned golden corpus and related decision boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-eligibility
```

The runner checks the real TypeScript with Vitest and fast-check, bounded TLC 1.7.4, expected counterexamples for weakened models, and a Z3 4.15.4 boolean obligation. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. The dispatcher check aliases pricing imports to current source rather than a potentially stale build. Use `/statechart` to inspect counterexamples and regenerate the model projection. For isolated mutations, set `PRICING_ELIGIBILITY_PRICING_ROOT` and `PRICING_ELIGIBILITY_DISPATCHER_ROOT` to package copies.

## Scope and evidence

The real-code reproduction selects a complete provider after rejecting a cheaper partial showback; partial-only selection fails closed. A separate admission test removes eligibility metadata from a real quote and checks the gate.

PricingEligibility checks 30 distinct states for complete, partial, and unknown states, optional showback, missing metadata, and quote and selection phases. It checks that selection requires complete state and explicit eligibility. Disabling the completeness check, marking partial quotes eligible, or admitting anything not explicitly ineligible each violates the invariant. The missing-metadata case abstracts a corrupted or incomplete quote; normal QuoteEngine output includes eligibility. The model assumes the completeness classification and quoted amounts are truthful and does not model budgets, reservations, external providers, TypeScript refinement, or every selection policy.

Z3 checks that the abstract boolean quote and selection gates imply complete state and present eligibility, with a witness for a successful complete case. `PRICING_ELIGIBILITY_PROOF_MUTATION=partial-eligible` and `ignore-missing` give counterexamples. This obligation does not authenticate provider data or establish real-code refinement.

The broker's quote-based helper requires a complete eligible quote, while its raw spend estimate remains a trusted caller assertion without quote provenance. The broker budget skill checks that helper separately; this skill does not verify other consumers or the rest of HoBo.

## Keep in sync

When covered code changes, review showback and dispatch semantics, run real-code checks and the bounded model, replay counterexamples against code, exercise broken variants of both pricing and the dispatch gate, regenerate the projection, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
