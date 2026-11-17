---
name: verify-budget-signal-arithmetic
description: Verify broker threshold crossings, recoveries and their numeric representation when changing budget signal calculations or CI validation.
---

# Budget signal arithmetic

**Properties:** A budget crossing or recovery follows the exact decimal sum of serialized usage and credits compared with the exact decimal threshold. A signal is refused when its numeric representation cannot preserve that decision. Rounding to nine decimal places previously crossed a budget before it was spent and could omit a recovery after a small credit.

**Review baseline:** commit `235c92be61026383fbb19a2a35b8a7a7953f5502`. PASS for the generated implementation tests, bounded models and exact-real induction obligations below.

## Covered code

- `packages/broker/src/budget-signals.ts` uses the serialized decimals of number inputs to sum usage and credits, compare each threshold, and refuse underflow or a numeric projection that reverses the decision. `budgetSignalThresholdUsd` exposes the threshold's numeric projection.
- `packages/broker/src/billing-decimal.ts` and `packages/pricing/src/decimal.ts` supply decimal conversion, arithmetic and formatting. The model assumes these operations implement exact decimal arithmetic.
- `packages/ci/src/policy.ts` checks the Broker threshold projection before accepting a signal. `packages/broker/test/budget-signal-arithmetic.test.ts` covers early crossings, sub-nanodollar charges, recovery, floating-point addition, unrepresentable values and 500 generated histories checked against an independent integer-unit reference (seed 614510). `packages/ci/test/budget-signal-policy.test.ts` checks real Broker-to-CI projection and rejects the previous rounded value.

## Run

From the repository root after installing workspace dependencies and initializing pinned submodules:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-budget-signal-arithmetic
```

The real-code check builds the CI workspace dependencies first. The runner checks checksum-pinned TLC 1.7.4; set `TLA2TOOLS` to that jar or let it download the jar. Set `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or let the proof install it temporarily. Java 11+, Python with pip, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` to read both models and their views.

## Scope and evidence

`BudgetThresholds` explores 75 states and up to four usage or credit operations, with a threshold of four abstract units. It checks the crossing state and emitted transition against exact spend minus credit. The chart draws four states and six arrows and hides 155 same-label steps. The historical rounding variant produces an early crossing after two usage operations; the real-code and generated tests reproduce the error.

`NumericWire` explores 12 states, comparing an abstract exact decision with an agreeing, opposite or underflowed wire value. It checks refusal of an inconsistent projection and acceptance of an agreeing projection. The chart hides six same-label steps. Removing that guard produces an accepted inconsistent decision; the implementation tests cover both underflow and a collapsed threshold comparison.

The Z3 obligations prove, for arbitrary nonnegative exact-real spend, credits and individual operation amounts and a positive threshold, that usage and credits preserve the modeled threshold state, emit justified crossings or recoveries, and return only agreeing wire decisions. Each premise has a witness; rounding and wire-check mutations produce counterexamples. The proofs assume the previous threshold state is correct. They do not prove decimal parsing or formatting, IEEE-number conversion, the TypeScript implementation's refinement of the models, authenticity or completeness of financial facts, or concurrent journal behavior.

Outputs remain numeric projections and cannot represent every exact decimal. A threshold underflow, an amount underflow or overflow, or a projection whose comparison would disagree with the exact decision causes refusal. Older signals calculated with nine-place rounding can conflict with the corrected replay; reconcile them and upgrade Broker and CI together. Existing consumers that assume nine-place thresholds need migration.

For scratch mutations, copy `packages/broker` or `packages/ci` to a temporary package directory, link its `node_modules`, and set `BUDGET_ARITHMETIC_BROKER_ROOT` or `BUDGET_ARITHMETIC_CI_ROOT` to that copy. Restore the earlier broker fold or CI threshold check; the corresponding real-code test must fail. Restore the code and rerun the skill.

## Keep in sync

Review covered code and uncommitted work since the baseline. Update the model and implementation tests for intended changes, replay counterexamples against code, run deliberately broken scratch versions and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
