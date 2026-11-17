---
name: verify-ci-financial-time
description: Verify CI financial observation freshness, funded runtime coverage and elapsed billing when changing timestamp handling.
---

# CI financial evidence and runtime

**Properties:** CI accepts only valid financial observations that are not future or older than retained evidence; changed facts require a newer instant. Provider and funded windows must cover the complete planned runtime. Free settlement must occur within its evidence window, completion cannot precede creation or be in the future, and whole-minute billing must cover the complete elapsed host or native runtime. Truncating sub-millisecond timestamps previously accepted future or changed evidence, used expired free minutes and undercounted a runtime by one minute.

**Review baseline:** commit `719f8cbe6cf9a5cb9635f6d0055dd66ae2393604`. PASS for the generated tests, bounded models and exact-real obligations below.

## Covered code

- `packages/broker/src/financial-time.ts` validates explicit-offset calendar timestamps, compares exact instants, adds whole milliseconds while retaining finer fractions, and rounds elapsed time up to whole minutes.
- `packages/ci/src/config.ts`, `store.ts`, `routing.ts` and `scheduler.ts` validate financial evidence, retained account/provider observations, rate attestations, runtime coverage and settlement times. `packages/ci-gh-actions/src/hosted-control.ts` and `hosted-relay.ts` apply the checks to hosted observations, pinned free windows and host completion.
- `packages/broker/test/hosting-evidence-time.test.ts` generates 500 timestamp additions (seed 614511) and 500 elapsed-minute cases (seed 614514) against integer nanoseconds. `packages/ci/test/configuration-store.test.ts` generates 100 observation histories (seed 614512), and `routing.test.ts` generates 500 fractional coverage pairs (seed 614513). Native usage finality and hosted relay/control tests exercise actual settlement, duration and no-side-effect refusals.

## Run

From the repository root after installing workspace dependencies and initializing pinned submodules:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-financial-time
```

The real-code check builds CI and hosted CI workspace dependencies first. The runner checks checksum-pinned TLC 1.7.4; set `TLA2TOOLS` to that jar or let it download it. Set `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or let the proof install it temporarily. Java 11+, Python with pip, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` to read each model and its view.

## Scope and evidence

`CiFinancialEvidence` explores 288 states for three abstract instants, valid or invalid time, changed facts and same or different timestamp spellings. It checks freshness and retained history. Its projection draws seven states and five arrows and hides 144 same-label steps. Invalid text has no meaningful instant; validity is checked separately from temporal order. The historical model accepts invalid, future, backwards and changed equal-instant evidence. Implementation tests reproduce those cases.

`CiTimeCoverage` explores 384 states for admission and free settlement with bounded durations and finer-grained observations. It checks that accepted evidence covers the complete interval. Its projection hides 192 same-label steps. The legacy model accepts evidence that expires too early, reproduced by routing, relay and settlement tests. `CiBilledDuration` explores 42 states and checks that the smallest whole-minute charge covers the complete interval. Its projection hides 21 same-label steps. The legacy model underbills; both hosted and native implementation tests reproduce the defect.

The Z3 obligations hold over the stated exact-real freshness and ordering guards, nonnegative integer-millisecond durations, and whole-minute rounding. Every premise has a witness; removing each guard or the final rounding correction yields a counterexample. These proofs do not establish timestamp parsing and addition implementation, TypeScript refinement, trusted clocks, source authenticity, external provider behavior, or concurrency. The generated real-code tests check examples of correspondence. Other CI and hosted workflows still contain time-dependent behavior outside these models and need separate review.

Persisted ambiguous, invalid or inconsistent financial observations and completion times now require reconciliation. Accurate clocks and truthful provider evidence remain host responsibilities. A failed or uncertain effect must retain its financial exposure.

For scratch mutations, copy `packages/broker`, `packages/ci` or `packages/ci-gh-actions` to a temporary package directory, link its `node_modules`, and set `CI_TIME_BROKER_ROOT`, `CI_TIME_CI_ROOT` or `CI_TIME_HOSTED_ROOT` respectively. Restore the old timestamp comparisons or truncate the new helper's fractional part; the real-code checks must fail. Restore the code and rerun the skill.

## Keep in sync

Review covered code and uncommitted work since the baseline. Update models and real-code tests for intended changes, replay counterexamples against code, run deliberately broken scratch variants and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
