---
name: verify-yard-generation-saga
description: Verify in-process Yard generation authorization, retry identity, coalescing and plan snapshots.
---

# Yard generation saga authorization and retry

**Properties:** Within one saga instance, a concurrent identical retry shares its pending provider operation, and a different plan using the same idempotency key is refused. A provider sees a snapshot of the submitted plan; cached results do not share mutable provider objects. After a provider call fails, a retry inspects the existing attempt rather than starting a second provision. A trusted host must explicitly approve the plan; the decision is rechecked at the provider boundary and before returning a cached result from `run`, and cannot change the private provider plan through its callback input.

**Review baseline:** commit `3d9ddf95b2738567113427457b47497b5d5750e1`. PASS for the bounded model and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/generation.ts` requires and rechecks a trusted host decision on a separate plan snapshot, snapshots provider plans, binds a key to the plan digest, publishes a pending operation before invoking pinned connector methods, snapshots results, and inspects after uncertain failures.
- `packages/broker/test/yard-generation-saga-identity.test.ts` exercises overlapping calls, uncertain failure and shared inspection, conflicting in-flight and completed plans, caller and provider mutations, pinned methods, and 30 generated conflicting attempts (seed 614596). `yard-generation-saga-authorization.test.ts` checks absent, denied, throwing, replaced and revoked decisions, mutated and retained callback inputs, cached results, and 40 generated decision pairs (seed 614599). `yard-placement-parsing.test.ts`, residency, Camp and funded-generation suites run alongside them.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-saga
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Java 11+, Python, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` with the model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardSagaRetry` explores 33 states and 65 steps for one key and one saga instance, with an overlapping retry, a conflicting plan, caller edits, provider completion or lost reply, and inspection. Its five-state projection hides 32 same-label steps. Three weakened model guards produce counterexamples. The model's transition relation allows only one provision; it does not independently prove provider behavior. Six real-source mutations in `python3 .agents/skills/verify-yard-generation-saga/mutations/runtime.py` each require a passing control and an actual assertion failure.

`YardSagaAuthorization` explores 30 states and 57 steps for one initial request, a missing, denied, accepted or plan-mutating decision, a replaced or revoked decision before dispatch, a cached retry and a retained callback input. Its four-state projection hides 47 same-label steps. Four weakened model guards yield counterexamples. Seven real-source mutations in `python3 .agents/skills/verify-yard-generation-saga/mutations/authorization.py` each require a passing control and a running assertion failure. The real-code test also reproduces a retained callback reference modifying the provider input if snapshot isolation is removed.

The lease and pending promise exist only in one process and do not survive restart or coordinate multiple instances. `inspect` returns the local cached result without calling a provider or checking authorization. The callback is a trusted host decision, not independent proof of policy, financial admission or quota. Direct saga use must supply the appropriate host checks; it does not verify a provider's honesty or actual resource creation. A different attempt ID is a different plan even if the idempotency key is the same. The models abstract digest collisions, connector internals, mutations during the synchronous initial clone, multiple instances, persistence, crash recovery and liveness; the authorization model treats one current Boolean host decision as an atomic step and does not model every retry interleaving; it does not prove TypeScript refinement. A connector that waits on a recursive call to its own pending operation can deadlock. The `verify-yard-generation-authority` and `verify-yard-generation-policy-gate` skills check separate bounded slices.

For broken-code checks, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_SAGA_VERIFY_PACKAGE_ROOT`, and separately disable the pending-operation lookup, plan-digest conflict check and plan snapshot in the copied `generation.ts`. Also separately allow a missing decision by supplying a permissive default and permitting it through the callback identity checks; bypass the provider-boundary recheck; remove the decision-plan digest check; and share the provider plan with the decision callback. Each full skill run must fail real-code assertions. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update models and tests for intended changes, replay counterexamples against code, test all seven broken scratch implementations and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
