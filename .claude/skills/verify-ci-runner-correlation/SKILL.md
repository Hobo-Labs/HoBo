---
name: verify-ci-runner-correlation
description: Check GitHub runner-job correlation and teardown decisions when changing CI runner custody or job selection.
---

# CI runner correlation

**Property:** Given the jobs returned for one GitHub run, if any job matching the runner has an executing status, correlation selects an executing job and the teardown guard blocks its removal.

**Why:** A runner can serve a different job after its reserved job finishes. Selecting only the old reservation can terminate the runner while the other job is still running.

**Result at sync commit `97d2fc9f898e57cd1f94a88123fbb8cdc7273e23`:** PASS for the generated implementation property, focused teardown test, bounded TLC model, and Z3 induction below.

## Covered code

- `packages/ci-gh-actions/src/jit-runner-correlation.ts`: `correlateRunnerOnRun`, `resolveRunnerAssignedJob`, and `assignmentBlocksRunnerTeardown`.
- `packages/ci-gh-actions/test/runner-correlation-priority.test.ts`: real-code tests and generated matching job lists.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-runner-correlation
```

The command runs the focused TypeScript tests with fast-check, TLC 1.7.4, and Z3 4.15.4. It requires installed workspace dependencies, Node, Java 11+, Python, and the pinned tools available through `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH`, or network access to install them. Use `/statechart` with `models/correlation-view.mts` to inspect results and regenerate the projection.

## Scope and evidence

The original counterexample has two matching jobs on the same run: the reserved job is completed and another is in progress. The old selection returns the completed job, which does not block teardown. Another counterexample has a queued reserved job past its grace period and an executing sibling. The implementation now prioritizes executing matches over queued and terminal matches, with the reserved job preferred only within the chosen priority tier. The test also exercises the real lookup-to-teardown path and 500 generated lists and orderings with seed 614467. The package suite passed 1,850 tests, with 10 skipped.

TLC explores 22 states for two matched jobs whose status is executing, queued, or finished. It checks that an executing job is selected and that teardown does not occur while one is executing. The statechart projection hides 13 same-state transitions. Replacing the selection with reserved-first or queued-first produces counterexamples. In a scratch copy, restoring the prior implementation makes the focused tests fail.

Z3 proves a priority-selection induction over an unbounded integer-indexed list: after considering another rank, the best rank dominates the entire matched prefix. `CI_CORRELATION_PROOF_MUTATION=ignore-next` produces a counterexample. This mathematical abstraction does not prove TypeScript refinement.

The rule covers only jobs actually returned for one run and the recognized executing status set. It assumes the GitHub response is accurate and runner matching identifies the intended runner. The lookup can return a queued match before checking a later run, is bounded across runs, and does not yet paginate all jobs; another run, an omitted page, a stale status, an unknown status, or a same-named foreign runner can still make the observation incomplete or ambiguous. Force-stop behavior and live GitHub/provider execution are outside this model. Strict fleet start authorization still lacks its production GitHub lookup and hook endpoint.

## Keep in sync

Review changes to the covered code since the sync commit. Replay counterexamples against the real code, update the tests and model for intentional behavior changes, run deliberate broken variants, regenerate the chart, and advance the sync commit only after confirming correspondence. Use `/maintain-formal-verification-skill`.
