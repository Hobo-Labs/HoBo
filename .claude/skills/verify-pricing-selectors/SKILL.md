---
name: verify-pricing-selectors
description: Check per-workload charge selection, product and meter binding, grouped rating, and historical quote replay in the pricing kernel.
---

# Pricing workload selectors and meter binding

**Property:** A `pricing-rating/v6` quote selects charges for each workload, rates only the measurements matching each selected charge, rejects a measured dimension with no applicable charge or meter, and rejects mismatched products and duplicate or missing meter and charge identities.

**Why:** Selecting charges from only the first workload can rate a mixed $1 and $100 workload as $2 or $200 solely according to input order. An unknown measurement dimension could instead be silently priced at $0.

**Review basis:** commit `f25e6b7cab6f033db041b344fee2eb7aa89ee88a`. Rerun these checks against current source. The models and proof do not establish that TypeScript refines them.

## Covered code

- `packages/pricing/src/{quote,rating,catalog,state}.ts`: version selection, agreement and product resolution, meter and charge identity checks, exact selectors, charge grouping, measurement aggregation, and rating.
- `packages/pricing/test/pricing-selectors.test.ts`: mixed selectors, permutation, fallback, tier grouping, fixed quantities, repeated workload objects, unpriced work, product mismatch, meter and charge identity, baseline/candidate subtraction, and v5 replay. A generated property checks 300 price and quantity combinations (seed 614488).
- `packages/pricing/test/golden-replay.test.ts`, `test/adversarial-10.test.ts`, and `contracts/consumer/quote-boundary.test.ts`: pinned v1–v5 output and related tier and contract boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-selectors
```

The runner checks real TypeScript with Vitest and fast-check, bounded TLC 1.7.4 models, expected historical counterexamples, and a Z3 4.15.4 grouping obligation. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. Use `/statechart` on each model to inspect counterexamples and regenerate projections. Set `PRICING_SELECTOR_VERIFY_PACKAGE_ROOT` to an isolated package copy for a scratch mutation.

## Scope and evidence

The real-code counterexample rates one unit at $1 and one at $100. V5 yields $2 or $200 according to order; v6 yields $101 in both orders. V5 also accepts an unmetered measurement as $0, whereas v6 rejects it. Thirteen deliberate implementation mutations covering selection, grouping, missing work, identity, ordering, replay and aliases failed the tests. The pricing suite passed 167 tests before the additional baseline/candidate regression; the dispatcher suite passed 263 and the consumer contract passed.

PricingSelectors checks 608 reachable states for two workloads with independently present or absent prices, two quantities, two prices, both orders, and historical or current behavior. It checks that current rated workloads are both priced and the linear total uses each workload's own price. Its 152-state constrained diagram hides 64 same-state steps. Two deliberate model mutations violate these properties, and an executable historical counterexample shows missing or incorrect pricing. PricingMeterBinding checks 64 states for product agreement, a known and unique meter, unique charge identities, and historical or current validation. Its diagram hides 32 same-state steps. Four removed checks violate its invariant; an executable historical counterexample shows invalid binding. These models abstract the implementation's pure calculation into selection and rating phases; they assume that selectors, product identity, meter membership, and quantities have been classified correctly. They do not cover all price kinds, tiers, multi-resource allocation, timestamps, external catalogs, or TypeScript refinement.

Z3 proves that adding an arbitrary nonnegative exact-real workload to either of two linear-price groups changes the total by that group's own price times its quantity. The premises have a positive witness; `PRICING_SELECTOR_PROOF_MUTATION=wrong-group` gives a counterexample. This induction does not prove tiered prices, fixed charges, rounding, source consumption, or the code implementation. Real-code tests exercise selected tier and fixed cases separately.

V1–v5 replay intentionally retains earlier selector and meter behavior; preserve and reconcile affected historical quotes. V6 also retains the source, time and ordering limitations documented in the pricing financial-source and time skills. Provider catalog contents and workload attributes are asserted inputs, and these checks cannot authenticate them.

## Keep in sync

For changes to covered code, review product binding, charge identities and selection, test mixed workloads and historical replay, run both models and the arithmetic obligation, replay counterexamples against code, exercise broken variants, regenerate diagrams, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
