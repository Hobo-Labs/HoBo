---
name: verify-ci-uncertain-capacity
description: Verify that uncertain CI runner slots retain capacity until confirmed teardown.
---

# CI uncertain-runner capacity

**Property:** A runner slot that becomes uncertain retains its reserved capacity. Resolving that uncertainty releases capacity once only after teardown is confirmed; a claimed slot uses execution settlement.

**Why:** Reusing capacity while a runner may still exist can overcommit the worker or start duplicate external work.

**Result at sync commit `1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded`:** PASS for the stated SQLite and PostgreSQL scenarios, bounded model, and abstract accounting obligations.

## Covered code

- `packages/ci/src/fleet-v2/{sqlite,postgres}-strict-store.ts`, `state-machine.ts`, and `strict-store.ts`.
- `packages/ci/test/fleet-v2-store-conformance.test.ts`.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-uncertain-capacity
```

The command runs the shared store conformance suite, TLC 1.7.4, and Z3 4.15.4. PostgreSQL cases run when `TESTCONTAINERS=1`, `HOBO_FLEET_ENROLLMENT_CI=1`, or `HOBO_CI_TEST_POSTGRES` supplies a test database. The container route requires Docker and the pinned PostgreSQL image in the test. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned installations for an offline run. Java 11+, Python, Node, Vitest, fast-check, and workspace dependencies are required. Use `/statechart` with `models/view.mts` to regenerate the projection.

## Scope and evidence

The shared conformance suite checks uncertain transitions from reserved, provisioning and registered states, refusal before a trusted teardown assertion, idempotent release, and claimed-slot settlement. It generates 50 histories per database using seed 614452, with different pre-uncertainty phases and repeated failed attempts. The suite passed with SQLite and a PostgreSQL 17 container. It assumes the trusted caller's `teardownConfirmed` assertion is true; neither store verifies provider evidence or records an evidence reference. The production strict GitHub runner integration remains unwired. The ordinary pre-claim `released` transition also relies on the caller to establish that release is safe.

TLC explores 11 states of an uncertain runner, an optional claim, recorded settlement, teardown confirmation and one capacity release. It checks that uncertainty retains the reservation, released capacity has confirmation, claimed releases go through settlement, and release happens at most once. Removing retention or confirmation produces counterexamples. Mutating the SQLite implementation to release on uncertainty makes the generated property fail.

Z3 proves that one abstract atomic confirmed release preserves nonnegative unbounded capacity accounting and cannot release twice, assuming the held amount and transaction are accurate. `UNCERTAIN_PROOF_MUTATION=omit-confirmation` yields a counterexample. This is not a proof of TypeScript refinement, external teardown, availability after counter exhaustion, liveness, or every database schedule.

## Keep in sync

Review changes to covered code, update tests and models for intended behavior, replay counterexamples against both stores, run deliberate scratch mutations, regenerate the chart, and advance the sync commit after confirming correspondence. Use `/maintain-formal-verification-skill`.
