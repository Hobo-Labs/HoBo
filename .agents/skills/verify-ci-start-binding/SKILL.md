---
name: verify-ci-start-binding
description: Check the transactional CI fleet start-binding and exact retry boundary.
---

# CI fleet start binding

**Property:** A job has at most one durable slot claim, a slot has at most one job claim, and only the same assignment, claim and credential can receive a prior nonterminal start receipt. A terminal or uncertain claim cannot authorize a start again.

**Why:** Two different runner slots must not receive start authorization for the same actual job, and a changed request must not be treated as the original committed authorization.

**Result at sync commit `1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded`:** PASS for the stated SQLite and PostgreSQL contract cases, generated retry cases, the bounded model, and the mathematical induction below.

## Covered code

- `packages/ci/src/fleet-v2/{sqlite,postgres}-strict-store.ts`, `parse.ts`, and `state-machine.ts`.
- `packages/ci/test/fleet-v2-store-conformance.test.ts`.
- The GitHub assignment boundary and hook are in `packages/ci-gh-actions/src/fleet-v2/start-fence.ts` and `packages/ci-gh-actions/templates/fleet-pre-job-hook.sh`; they are not wired into the production controller and are not proved here.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-start-binding
```

The command runs the shared conformance suite on SQLite and a bounded TLC 1.7.4 model, then proves an abstract unbounded uniqueness induction with Z3 4.15.4. It checks PostgreSQL too when `TESTCONTAINERS=1`, `HOBO_FLEET_ENROLLMENT_CI=1`, or `HOBO_CI_TEST_POSTGRES` supplies a test database. The container route requires Docker and the test's pinned PostgreSQL image. Java 11+, Python, Node, Vitest, fast-check, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned installations for an offline run. Use `/statechart` with `models/view.mts` to regenerate the chart.

## Scope and evidence

The real-store conformance suite races two registered slots for one actual job, checks one committed claim and an identical retry, and generates 150 combinations of matching or mismatched runner, profile, secret and claim. It checks that retries do not append events and that a completed claim cannot authorize again. The same suite passed with SQLite and a PostgreSQL 17 test container at the sync commit. The fleet-column migrations, exhaustion guards, and uncertain-slot recovery change availability and settlement, not the modeled assignment binding; the conformance suite checks those boundaries separately. It does not cover a live GitHub runner, process crashes, network failures, or every possible database schedule.

TLC explores two jobs and two slots (213 reachable states). A boolean abstracts all checks that must match for a receipt; a terminal boolean abstracts terminal and uncertain claims. A committed job-to-slot association remains a tombstone. The model checks that neither a job nor a slot is rebound and that an accepted receipt matches a nonterminal binding. Removing the retry-match guard violates `ReceiptValid`; removing slot uniqueness violates `NoSlotRebinding`. Removing the implementation's retry-assignment check in a scratch SQLite copy causes the conformance test to fail.

Z3 proves that an abstract atomic assignment preserves unique slot ownership for unbounded integer job and slot identifiers, assuming the initial mapping is unique, the job has no prior owner, and the slot is unused. `START_BINDING_PROOF_MUTATION=omit-slot-guard` produces a counterexample. The proof does not establish that TypeScript refines this model, that a database transaction or GitHub's assignment evidence works as assumed, or that runner code executes exactly once. The store trusts the caller's verified-assignment assertion. See the operator guide for the unwired production lookup and hook endpoint.

## Keep in sync

Review covered code changes, update the executable checks and model for intended behavior, replay counterexamples against the stores, run both database implementations and deliberate scratch mutations, regenerate the chart, and advance the sync commit only after confirming correspondence. Use `/maintain-formal-verification-skill`.
