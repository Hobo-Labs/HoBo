---
name: verify-pricing-credit-order
description: Check credit selection, economic basis, and versioned replay when changing pricing quote ordering or credit consumption.
---

# Pricing credit ordering

**Property:** With equal-priority, equal-expiry eligible credits, a new `pricing-rating/v3` quote selects credits independently of the process locale and accounts for the consumed credit's basis. Explicit v1 replay keeps the former locale-dependent order.

**Why:** Different credit choices can change the effective cost used for routing even when the scenario is identical. Before this fix, English and Swedish processes consumed different $10 credits and reported $0 versus $9 in effective cost.

**Review basis:** commit `83f771f399435d931da14129cc8265e15f640fe6`. Rerun the checks against the current source before relying on this result. The model and arithmetic proof do not establish that TypeScript refines them.

## Covered code

- `packages/pricing/src/{quote,state,catalog,rating,order}.ts`: version selection, working-state ordering, rating, consumption and basis.
- `packages/pricing/test/pricing-locale.test.ts` and `test/fixtures/pricing-locale.mts`: cross-process locale tests, old/new versions, and generated credit permutations.
- `packages/pricing/test/golden-replay.test.ts`, `test/adversarial-10.test.ts`, and `contracts/consumer/quote-boundary.test.ts`: stored v1 replay and selected pricing and consumer boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-credit-order
```

The runner checks real TypeScript with Vitest and fast-check, TLC 1.7.4, an expected legacy counterexample, and a Z3 4.15.4 arithmetic obligation. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. Use `/statechart` to inspect counterexamples and regenerate the projection from the model and view. For a deliberate scratch mutation, set `PRICING_VERIFY_PACKAGE_ROOT` to an isolated package copy containing its tests, fixtures, contracts, and corpus.

## Scope and evidence

The implementation test runs English and Swedish child processes against the same quote. Both v3 processes consume credit `z` and report $9 effective cost; v1 consumes promotional `ä` and reports $0 in English, while Swedish v1 consumes `z` and reports $9. It checks 300 generated pairs of credit IDs and both input orders (seed 614482), including remaining balances. The pinned v1 and v2 goldens and pricing consumer contract pass; the pricing suite passed 110 tests and the downstream dispatcher suite passed 263. Six scratch code mutations that change current ordering, v1 replay, version identity, the ID tie-break, debit, or basis fail the tests.

PricingCreditOrder explores 24 reachable states for two hosts, three algorithm versions, two paid-credit basis values, and one complete use of one of two equal-priority credits. It checks credit conservation, basis attribution, and matching v2 and v3 results. The projection hides six same-state steps. Three model mutations violate those properties. An executable expected counterexample shows that v1 can differ across locales. The model assumes both credits are eligible and fully cover one use; it does not model partial credit consumption, rate cards, rounding, retries, temporal validity, or provider behavior.

Z3 proves a single abstract credit use preserves nonnegative balances and total balance for unbounded nonnegative exact-real amounts when either credit can fully cover the use and the ordered identity selects the credit. Its premises have a witness; `PRICING_CREDIT_PROOF_MUTATION=omit-debit` produces a counterexample. It does not prove proportional basis arithmetic, TypeScript refinement, or persistent accounting.

Explicit v1 replay needs the original locale for tied histories, and an existing quote should be preserved as evidence. New v2 and v3 quote hashes differ because the algorithm version changes. Explicit v1 and v2 replay preserves earlier timestamp behavior; temporal correctness is covered separately by verify-pricing-time.

## Keep in sync

When covered code changes, review intended credit order and version compatibility, run the real-code checks and bounded model, replay counterexamples against code, try deliberately broken variants, regenerate the chart, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
