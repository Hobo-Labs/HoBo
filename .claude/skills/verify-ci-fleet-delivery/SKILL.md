---
name: verify-ci-fleet-delivery
description: Verify strict fleet effect delivery fences, expiry, and ambiguous dispatch.
---

# CI fleet effect delivery

**Property:** A delivery receives a fresh bounded fence; an expired worker cannot renew or acknowledge a later delivery, and an effect already dispatching cannot be reissued when its lease expires.

**Why:** Reused fencing tokens or automatic retries after an ambiguous external dispatch can authorize duplicate mutations.

**Result at sync commit `1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded`:** PASS for the stated SQLite and PostgreSQL cases, bounded model, and arithmetic abstraction.

## Covered code

- `packages/ci/src/fleet-v2/{sqlite,postgres}-strict-store.ts`, `effect-fence.ts`, and `state-machine.ts`.
- `packages/ci/test/fleet-v2-store-conformance.test.ts` and `packages/ci/data-models/fleet_v2.proto`.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-fleet-delivery
```

The command runs the shared store conformance suite, TLC 1.7.4, and Z3 4.15.4. PostgreSQL cases run with `TESTCONTAINERS=1`, `HOBO_FLEET_ENROLLMENT_CI=1`, or `HOBO_CI_TEST_POSTGRES` set to a test database. The container route requires Docker and the test's pinned PostgreSQL image. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned installations for offline runs. Java 11+, Python, Node, Vitest, fast-check, and workspace dependencies are required. Use `/statechart` with `models/view.mts` to regenerate the chart.

## Scope and evidence

The shared conformance suite runs 25 generated expiry/reclaim histories per database with seed 614453, including repeated worker identities. It checks stale renewal and acknowledgement refusal, refusal to reissue a dispatching effect after expiry, maximum unsigned fence/epoch/policy/observation values, fence exhaustion, and concurrent upgrade of legacy PostgreSQL columns with retained rows. It passed on SQLite and PostgreSQL 17. Tests do not exercise a real provider, arbitrary process crashes, every database schedule, or clock anomalies.

TLC explores 33 states with two possible fence values. It checks bounded fences, no reused or stale-acknowledged token, and no reissue after dispatch. An expired dispatch is abstracted as having no active authority; the actual stored delivery can still be marked claimed while its expiry blocks use. Mutating the model to wrap the counter violates `NoReusedToken`; allowing reissue during dispatch violates `NoReissueAfterDispatch`. Reusing an implementation fence in a scratch SQLite copy makes the generated history check fail on the delivery uniqueness constraint.

Z3 proves that an abstract increasing bounded integer fence differs from every earlier positive fence. `FLEET_DELIVERY_PROOF_MUTATION=wrap` produces a counterexample. This is not a proof that TypeScript refines the model or that database transactions, clocks, and providers satisfy the assumptions. A fence at the uint32 maximum prevents further claims; it must not be reset because stale tokens could become valid. Continued operation requires a future format migration and reconciliation.

## Keep in sync

Review covered changes, update implementation checks and models, replay counterexamples against both stores, run deliberate scratch mutations, regenerate the chart, and advance the sync commit after confirming correspondence. Use `/maintain-formal-verification-skill`.
