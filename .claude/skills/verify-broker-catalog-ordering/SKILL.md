---
name: verify-broker-catalog-ordering
description: Verify exact, deterministic and comparable catalog-price selection in the general broker.
---

# Broker catalog price ordering

**Properties:** Among eligible definitions in the selected policy scope, the broker compares nonnegative decimal marginal prices exactly, requires matching units and distinct definition IDs, and breaks ties by stable provider and definition identities. It rejects invalid definitions, failing capability checks, and a selected region or price that changes during placement. A pinned policy ignores unrelated providers.

**Review baseline:** commit `7e6f4d1bc8be723f45d3425a26ec34eabf158315`. PASS for the generated cases, bounded models and symbolic obligations below.

## Covered code

- `packages/broker/src/broker.ts` filters the policy's candidates, validates catalog identities and prices, compares exact decimals, checks the selected snapshot and constructs the placement. `rejections.ts` catalogs the refusal codes.
- `packages/pricing/src/decimal.ts` parses and compares decimal values. This skill relies on those operations and exercises them through the broker.
- `packages/broker/test/catalog-ranking.test.ts` reproduces lost floating-point precision, malformed and negative prices, incomparable units, duplicate identities, locale-dependent ties, changed regions and prices, failed capability checks and pinned-provider behavior. It compares 300 generated high-precision price arrays and their reverse permutations against an integer reference (seed 614519).
- `quote-admission.test.ts` checks the subsequent host quote and budget admission path, not whole-plan optimization.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-catalog-ordering
```

The shared runner checks checksum-pinned TLC 1.7.4. Set `TLA2TOOLS` to its jar and `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or allow the runner to obtain them. Java 11+, Python with pip, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` with the models and their views.

## Scope and evidence

`CatalogOrdering` explores 256 states for two abstract candidates with two abstract prices, validity, units, identity and tie order. It checks valid and comparable evidence, unique IDs, the minimum catalog price and stable ties. The six-state projection has four arrows and hides 128 same-label steps. `CatalogSnapshot` explores eight states for changing selected price and region evidence; its four-state projection hides four same-label steps. Six weakened model guards yield counterexamples. Implementation tests replay those categories, including high-precision values and selected evidence changes.

Z3 checks two arbitrary nonnegative exact-real prices and the stated Boolean guards, including minimum and tie ordering. Every premise has a witness; removing any of five guards produces a counterexample. It does not prove TypeScript refinement, numeric parsing, actual billing or source truth.

This checks only the general broker's per-resource catalog ordering. The bare catalog format lacks a reliable currency or price-completeness marker; zero may mean unpriced. A common unit does not establish equal workload quantities, discounts or whole-request cost. The broker quotes only the selected plan, so it can miss a cheaper or affordable alternative. It does not prove global cost optimality. Yard-first placement and the cloud planner have their own ranking paths. Host callbacks and catalog hashes remain trusted boundaries, and changes after the final check are not modeled.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules` and set `BROKER_RANKING_VERIFY_PACKAGE_ROOT`. Restore the old broker, use floating-point prices, omit validation or unit/identity checks, change the tie ordering, or remove snapshot rechecks. The real-code tests must fail. Restore the source and rerun the skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline, update both models and generated tests, replay counterexamples, run broken scratch variants and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
