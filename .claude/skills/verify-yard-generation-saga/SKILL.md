---
name: verify-yard-generation-saga
description: Verify in-process Yard generation retry identity, coalescing and plan snapshots.
---

# Yard generation saga retry

**Properties:** Within one saga instance, a concurrent identical retry shares its pending provider operation, and a different plan using the same idempotency key is refused. A provider sees a snapshot of the submitted plan; cached results do not share mutable provider objects. After a provider call fails, a retry inspects the existing attempt rather than starting a second provision.

**Review baseline:** commit `6771c17c043c776bb4b6d5b14e451d4935eb8b97`. PASS for the bounded model and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/generation.ts` snapshots plans, binds a key to the plan digest, publishes a pending operation before invoking pinned connector methods, snapshots results, and inspects after uncertain failures.
- `packages/broker/test/yard-generation-saga-identity.test.ts` exercises overlapping calls, uncertain failure and shared inspection, conflicting in-flight and completed plans, caller and provider mutations, pinned methods, and 30 generated conflicting attempts (seed 614596). `yard-placement-parsing.test.ts`, residency, Camp and funded-generation suites run alongside it.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-saga
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Java 11+, Python, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` with the model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardSagaRetry` explores 33 states and 65 steps for one key and one saga instance, with an overlapping retry, a conflicting plan, caller edits, provider completion or lost reply, and inspection. Its five-state projection hides 32 same-label steps. Three weakened model guards produce counterexamples. The model's transition relation allows only one provision; it does not independently prove provider behavior. Six real-source mutations in `python3 .agents/skills/verify-yard-generation-saga/mutations/runtime.py` each require a passing control and an actual assertion failure.

The lease and pending promise exist only in one process and do not survive restart or coordinate multiple instances. This is not an authorization or quota mechanism; direct saga use does not itself verify policy, financial admission, a provider's honesty or actual resource creation. A different attempt ID is a different plan even if the idempotency key is the same. The model abstracts digest collisions, connector internals, mutations during the synchronous initial clone, persistence, crash recovery and liveness; it does not prove TypeScript refinement. A connector that waits on a recursive call to its own pending operation can deadlock. The `verify-yard-generation-authority` and `verify-yard-generation-policy-gate` skills check separate bounded slices.

For broken-code checks, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_SAGA_VERIFY_PACKAGE_ROOT`, and separately disable the pending-operation lookup, plan-digest conflict check and plan snapshot in the copied `generation.ts`. Each full skill run must fail real-code assertions. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update models and tests for intended changes, replay counterexamples against code, test all three broken scratch implementations and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
