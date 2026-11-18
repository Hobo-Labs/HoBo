---
name: verify-yard-generation-quota
description: Verify atomic SQLite generation quota reservations, tenant inventory accounting and verified readiness.
---

# Yard generation quota authority

**Properties:** Within one authority database, a new reservation atomically counts all pending generations and a tenant's initial and claimed Yards before accepting a fixed positive limit. A repeated key is bound to the same attempt, tenant, Yard, plan and limits. Uncertain claims remain pending, and a concurrent slot is released only after a trusted verifier accepts readiness bound to the claim; the Yard remains counted for its tenant.

**Review baseline:** commit `740ac76b563e4b81895fbfe1adce95b70fba0f55`. PASS for the bounded model, integer abstraction and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/generation-quota.ts` initializes a fixed scope, baseline and limits, serializes count-and-reserve with SQLite `BEGIN IMMEDIATE`, validates idempotent claims and verified readiness, and refuses in-memory databases.
- `packages/broker/test/yard-generation-quota.test.ts` checks limits, an over-limit initial inventory, persistence across connections, conflicting identities and settings, readiness binding, memory URIs, 40 generated reserve/ready histories (seed 614597), and two actual worker threads racing for the last slot.
- The authority is exported by `packages/broker/src/yard-placement/index.ts` and `packages/broker/src/index.ts`. Placement does not yet use this authority; these checks do not establish quota enforcement in the deployment path.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-quota
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation or let the check install that pinned version in a temporary directory. Java 11+, Python with pip, Node with SQLite and workspace dependencies are required. Use `/statechart` with the model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardGenerationQuota` explores 13 states and 27 steps for three requests, two tenants, one active slot, a two-Yard tenant cap and one initial Yard. It checks active and tenant bounds and that modeled readiness is verified. Its three-state projection follows the first request and hides 23 same-label steps. Four weakened model guards produce counterexamples. The model assumes its initial inventory is within the cap; actual over-limit baselines are accepted but cannot admit another Yard for that tenant.

Z3 proves the stated reserve and completion inequalities over unbounded integers with fixed positive limits, nonnegative counters and a safe starting state. Three weakened premises produce counterexamples. This is an arithmetic abstraction, not proof that TypeScript or SQLite refines it. The real SQLite tests exercise two independent worker threads; source mutation checks first require a passing control and then a failed assertion.

The host must provide a complete initial inventory, send all later Yard creations through the same database, preserve that database, use the same fixed scope and limits, and supply an honest readiness verifier. The authority does not independently inspect a provider, import pre-existing uncertain operations, reconcile unused reservations, remove deleted Yards, support changing limits in place, or coordinate separate databases. A false readiness assertion, missing initial Yard or out-of-band creation can violate a real-world quota. It does not prove filesystem durability, crash recovery, liveness or TypeScript refinement.

For broken-code checks, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_QUOTA_VERIFY_PACKAGE_ROOT`, and separately disable the concurrent-limit guard, tenant-limit guard and readiness verifier in the copied `generation-quota.ts`. Each full skill run must fail a real assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the model, integer obligations and tests for intended changes; replay counterexamples against code, test all three broken scratch implementations and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
