---
name: verify-yard-residual-placement
description: Verify capability, region, provider and catalog-price evidence for residual resources in the Yard-first broker when changing its placement code.
---

# Yard residual placement

**Properties:** A residual resource is placed only on a full capability match in its Yard provider or an explicitly compatible wildcard, in a region supported by the definition. Eligible catalog entries must have distinct identities, valid nonnegative decimal prices and matching units; the lowest exact marginal price wins with stable ID ties. Catalog evidence changed while resolving resources rejects. A failure can route a resource to an unsupported region, omit required capabilities, misrepresent its provider, or select the wrong catalog price.

**Review baseline:** commit `709ea76715f765cd0d88690bda8dd8fee4f148b8`. PASS for the bounded models, symbolic abstraction and generated tests below. The request parser refuses malformed constraints and estimates before matching; `verify-yard-request-validation` checks that boundary separately. `verify-yard-json-constraints` checks structural property matching, and `verify-yard-residency-validation` checks residency preflight before this modeled residual placement.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` snapshots the request, filters provider definitions and implements `placeResourcesUnderYard`; it snapshots provider and candidate evidence, invokes capability checks, validates regions and prices, ranks candidates and rechecks evidence across all resources. `verify-yard-resource-binding` checks the subsequent association of selected definitions to execution units.
- `packages/pricing/src/decimal.ts` supplies exact decimal parsing and comparison. The tests exercise it through actual Yard-first placement.
- `packages/broker/test/yard-residual-placement.test.ts` checks partial and false wildcard verdicts, unsupported or malformed regions, callback failures, changed providers or price evidence, high-precision prices, incomparable units and duplicate IDs. Eighty generated arrays and their reverse permutations are compared with an independent integer reference (seed 614522).
- `yard-placement.test.ts`, `yard-event-store-folds.test.ts` and `hosting-budget.test.ts` exercise integration with Yard matching, generation and budget admission.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-residual-placement
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or allow the runner to obtain them. Java 11+, Python, Node, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` to inspect each model and its view and to read any counterexample.

## Scope and evidence

`YardResidualEvidence` explores 50 states for one resource, three capability verdicts and abstract region, provider and stability flags. It checks that a selected definition has a full match, supported region, eligible provider and stable evidence. Its four-state projection hides 24 same-label steps. The model abstracts the callback and subsequent recheck; the real-code tests include one callback changing another resource's previous selection. Wildcard providers are represented by the eligible-provider flag and still require a full capability verdict.

`YardResidualRanking` explores 256 states for two candidates, two abstract prices, validity, units, unique IDs and tie order. It checks valid and comparable prices, distinct identities, minimum price and stable ties. Its three-state projection hides 128 same-label steps. Z3 checks the same ordering obligations for two arbitrary nonnegative exact-real prices and the stated Boolean guards; it assumes correct parsing. Nine weakened model guards and five weakened proof guards produce counterexamples. Real-code tests reproduce partial and false wildcard matches, unsupported regions, provider and cross-resource mutations, changed or incomparable prices and duplicate IDs.

This compares individual marginal prices only. Equal units do not prove equal quantities, currency, complete workloads or whole-request optimality. The host's catalog hash, capability callbacks and pricing evidence remain trust boundaries; this does not detect a change restored between checks or one made after placement returns. Camp input and Yard containment are checked separately by `verify-yard-camp-binding`. Local hosting authorization and funded quote, content and context fences are checked separately by `verify-yard-local-hosting` and `verify-yard-funded-admission`. The funded-admission skill checks quote-to-work binding separately. This skill does not prove the outer broker receipt or execution path, TypeScript refinement or liveness.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_RESIDUAL_VERIFY_PACKAGE_ROOT`, and allow a partial capability verdict or replace exact comparison with floating point. The real-code checks must fail. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
