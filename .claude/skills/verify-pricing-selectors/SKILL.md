---
name: verify-pricing-selectors
description: Check per-workload charge selection, product and meter binding, tier coverage, and grouped rating in the pricing kernel.
---

# Pricing workload selectors and meter binding

**Property:** A quote selects charges for each workload, rates only the measurements matching each selected charge, rejects a measured dimension with no applicable charge or meter, rejects mismatched products and duplicate or missing meter and charge identities, and validates tier ranges before rating.

**Why:** Selecting charges from only the first workload can rate a mixed $1 and $100 workload as $2 or $200 solely according to input order. An unknown measurement dimension could instead be silently priced at $0; tier gaps and overlaps could price eight units as five or eleven.

**Review basis:** commit `e9c20aea41e67c779a47d169e25de38ce28552fa`. Rerun these checks against current source. The models and proof do not establish that TypeScript refines them.

## Covered code

- `packages/pricing/src/{quote,rating,catalog,state}.ts`: agreement and product resolution, meter and charge identity checks, exact selectors, charge grouping, measurement aggregation, and rating.
- `packages/pricing/test/pricing-selectors.test.ts`: mixed selectors, permutation, fallback, tier grouping, fixed quantities, repeated workload objects, unpriced work, product mismatch, meter and charge identity, and baseline/candidate subtraction. A generated property checks 300 price and quantity combinations (seed 614488).
- `packages/pricing/test/pricing-tier-coverage.test.ts`: valid and invalid tier boundaries, finite limits, and 600 generated schedules (seeds 614490 and 614491).
- `packages/pricing/test/golden-replay.test.ts`, `test/adversarial-10.test.ts`, and `contracts/consumer/quote-boundary.test.ts`: the pinned golden corpus and related tier and contract boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-selectors
```

The runner checks real TypeScript with Vitest and fast-check, bounded TLC 1.7.4 models, expected counterexamples for weakened models, and Z3 4.15.4 grouping and tier obligations. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. Use `/statechart` on each model to inspect counterexamples and regenerate projections. Set `PRICING_SELECTOR_VERIFY_PACKAGE_ROOT` to an isolated package copy for a scratch mutation.

## Scope and evidence

The real-code counterexample rates one unit at $1 and one at $100 and yields $101 in both orders; an unmetered measurement is rejected rather than rated at $0.

PricingSelectors checks 288 distinct states for two workloads with independently present or absent prices, two quantities, two prices, and both orders. It checks that rated workloads are both priced and the linear total uses each workload's own price. Its constrained diagram configuration explores 72 states. Selecting only the first workload's charges, or rating every workload at the first workload's price, violates the corresponding property. PricingMeterBinding checks 32 states for product agreement, a known and unique meter, and unique charge identities. Removing any of the four checks violates its invariant. These models abstract the implementation's pure calculation into selection and rating phases; they assume that selectors, product identity, meter membership, and quantities have been classified correctly. They do not cover all price kinds, tiers, multi-resource allocation, timestamps, external catalogs, or TypeScript refinement.

PricingTierCoverage checks 84 distinct states for two abstract tiers and sample points. It checks that each rated point is covered exactly once. Removing the adjacency check produces a counterexample with a gap or overlap. This abstraction assumes the first tier begins at zero and the last extends without bound; it does not model finite endpoints, arbitrary tier counts, numeric parsing, rounding or the pricing implementation. Real-code tests separately check finite final boundaries, inferred ends, order, and multiple pricing modes.

Z3 proves that two adjacent abstract ranges cover every nonnegative exact-real point exactly once. Its premises have a witness; `PRICING_TIER_PROOF_MUTATION=omit-adjacency` gives a counterexample. It does not prove TypeScript refinement, monetary arithmetic, finite endpoints or provider catalog authenticity.

Z3 proves that adding an arbitrary nonnegative exact-real workload to either of two linear-price groups changes the total by that group's own price times its quantity. The premises have a positive witness; `PRICING_SELECTOR_PROOF_MUTATION=wrong-group` gives a counterexample. This induction does not prove tiered prices, fixed charges, rounding, source consumption, or the code implementation. Real-code tests exercise selected tier and fixed cases separately.

The rating algorithm also retains the source, time and ordering limitations documented in the pricing financial-source and time skills. Provider catalog contents and workload attributes are asserted inputs, and these checks cannot authenticate them.

## Keep in sync

For changes to covered code, review product binding, charge identities and selection, test mixed workloads, run the models and the arithmetic obligations, replay counterexamples against code, exercise broken variants, regenerate diagrams, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
