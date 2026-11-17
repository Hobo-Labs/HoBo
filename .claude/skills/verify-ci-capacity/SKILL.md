---
name: verify-ci-capacity
description: Verify fleet capacity revisions, stale admissions, and counter exhaustion.
---

# CI fleet capacity admission

**Property:** A reservation based on a stale capacity revision must not be admitted, and a committed capacity revision must remain inside the unsigned 32-bit wire range without wrapping or being reused.

**Why:** A stale reservation can invalidate capacity or policy decisions. A wrapped or unparseable revision can make old decisions appear current or strand the group.

**Result at sync commit `5b1189203aaf503ae5d4c6271daae7b9342689af`:** PASS for the bounded models, generated SQLite cases, SQLite and PostgreSQL conformance, and the stated arithmetic abstractions.

## Covered code

- `packages/ci/src/fleet-v2/{sqlite,postgres}-strict-store.ts`, `capacity-sequence.ts`, and `parse.ts`.
- `packages/ci/test/fleet-capacity.property.test.ts` and `fleet-v2-store-conformance.test.ts`.
- `packages/ci/data-models/fleet_v2.proto` (`CapacityGroup` and capacity units).

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-capacity
```

The command runs the shared store conformance suite, SQLite generated properties, TLC 1.7.4, and Z3 4.15.4. The PostgreSQL cases run when `TESTCONTAINERS=1`, `HOBO_FLEET_ENROLLMENT_CI=1`, or `HOBO_CI_TEST_POSTGRES` supplies a test database. The container route requires Docker and the pinned PostgreSQL image in the test. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to the pinned installations for an offline run. Java 11+, Python, Node, Vitest, fast-check, and workspace dependencies are required. Use `/statechart` with `models/view.mts` for the reservation projection.

## Scope and evidence

The generated SQLite check uses seed 614441 and 80 examples with 2–12 units and 2–12 competing jobs, each asking for one unit against the same revision; collectively they fit, so exhaustion cannot explain rejection of stale requests. The conformance suite races two such requests against SQLite and a real PostgreSQL 17 container. It also exercises a value above PostgreSQL's signed 32-bit range through reservation and settlement, concurrent migration of legacy columns with retained data, and rollback of updates, reservations, pre-claim releases and settlement at the maximum wire revision. The tests do not cover every database schedule or external provider effect.

`FleetCapacity` models two jobs reading revision zero with two units available. `CapacityExhaustion` models the final admissible increment and refusal at a small representative limit. TLC's finite exploration checks these abstractions, not all implementation states. The Z3 induction proves that any number of abstract contenders using the same initial revision can obtain at most one successful reservation, assuming atomic comparison and increment and no revision reset. It also proves that an increment guarded below the unsigned maximum stays within range. These are proofs of abstractions, not TypeScript-to-model refinement or database correctness.

Removing the SQLite revision predicate made the generated check admit two contenders. Removing it in `FleetCapacity` violates `NoStaleAdmission`; removing the limit guard in `CapacityExhaustion` violates `NoOverflow`. Set `CAPACITY_PROOF_MUTATION=omit-revision-guard` or `omit-limit-guard` to obtain Z3 counterexamples. Revisions at their maximum reject further updates, including releases; a future revision-format migration and operator reconciliation are needed. Never reset a revision to recover, because stale inputs could become valid again. Other PostgreSQL fleet fields have separate range and exhaustion requirements.

## Keep in sync

Review covered code changes, update the executable checks and models for intended behavior, replay counterexamples against the stores, run both database implementations and deliberate scratch mutations, regenerate the chart, and advance the sync commit only after confirming correspondence. Use `/maintain-formal-verification-skill`.
