---
name: verify-ci-runner-correlation
description: Check GitHub runner-job correlation and teardown decisions when changing CI runner custody or job selection.
---

# CI runner correlation

**Property:** Given the jobs returned across the scanned GitHub runs, if any job matching the runner has an executing status, correlation selects an executing job and the teardown guard blocks its removal. Fail-closed mode retains the runner when a scan or served-job lookup fails, including after a partial queued match.

**Why:** A runner can serve a different job after its reserved job finishes. Selecting only the old reservation can terminate the runner while the other job is still running.

**Result at sync commit `fd826bf1aedeffa9b532906ce86b4d122dc9817f`:** PASS for the generated implementation properties, focused teardown tests, bounded TLC models, and Z3 induction below.

## Covered code

- `packages/ci-gh-actions/src/jit-runner-correlation.ts`: `correlateRunnerOnRun`, `resolveRunnerAssignedJob`, and `assignmentBlocksRunnerTeardown`.
- `packages/ci-gh-actions/test/runner-correlation-priority.test.ts`: real-code tests and generated matching job lists.
- `packages/ci-gh-actions/test/runner-cross-run-safety.test.ts`: real-code cross-run, incomplete lookup, grace-period, and force-stop cases.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-runner-correlation
```

The command runs the focused TypeScript tests with fast-check, TLC 1.7.4, and Z3 4.15.4. It requires installed workspace dependencies, Node, Java 11+, Python, and the pinned tools available through `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH`, or network access to install them. Use `/statechart` with `models/correlation-view.mts` or `models/cross-run-view.mts` to inspect results and regenerate the projections.

## Scope and evidence

The original counterexample has two matching jobs on the same run: the reserved job is completed and another is in progress. The old selection returns the completed job, which does not block teardown. Another counterexample has a queued reserved job past its grace period and an executing sibling. The implementation now prioritizes executing matches over queued and terminal matches, with the reserved job preferred only within the chosen priority tier. Across runs, it continues past a queued match to look for executing work. A failed later scan marks an observed queued match incomplete; fail-closed teardown retains the runner. A failed scan cannot be overridden by a completed served-job lookup in fail-closed mode. The tests exercise the lookup-to-teardown path, 500 generated same-run lists with seed 614467, and 100 generated cross-run cases with seed 614468. The package suite passed 1,857 tests, with 10 skipped.

TLC explores 22 states for two matched jobs whose status is executing, queued, or finished. It checks that an executing job is selected and that teardown does not occur while one is executing. The statechart projection hides 13 same-state transitions. Replacing the selection with reserved-first or queued-first produces counterexamples. In a scratch copy, restoring the prior implementation makes the focused tests fail.

RunnerCrossRun explores 96 states for a queued or absent preferred match, an executing or absent later match, complete or failed lookups, grace, and fail-closed or force-stop mode. It checks that observed executing work blocks teardown, incomplete lookups block in fail-closed mode, and a recent queued match blocks in either mode. Its projection hides 48 same-state transitions. Mutations that return the first queued match, allow an incomplete strict lookup, or ignore queued grace violate the respective invariants; real-code mutations of early return and both failure guards fail their tests. The model abstracts direct served-job lookup as a possible failure and does not represent every GitHub response or retry schedule.

Z3 proves a priority-selection induction over an unbounded integer-indexed list: after considering another rank, the best rank dominates the entire matched prefix. `CI_CORRELATION_PROOF_MUTATION=ignore-next` produces a counterexample. This mathematical abstraction does not prove TypeScript refinement.

The rule covers only jobs actually returned by the bounded scan and the recognized executing status set. It assumes the GitHub response is accurate and runner matching identifies the intended runner. The scan is bounded across runs and does not yet paginate all jobs; an omitted page, a stale status, an unknown status, or a same-named foreign runner can still make the observation incomplete or ambiguous. Force-stop deliberately allows teardown when work cannot be confirmed and the queued grace period has expired. Live GitHub/provider execution is outside these models. Strict fleet start authorization still lacks its production GitHub lookup and hook endpoint.

## Keep in sync

Review changes to the covered code since the sync commit. Replay counterexamples against the real code, update the tests and model for intentional behavior changes, run deliberate broken variants, regenerate the chart, and advance the sync commit only after confirming correspondence. Use `/maintain-formal-verification-skill`.
