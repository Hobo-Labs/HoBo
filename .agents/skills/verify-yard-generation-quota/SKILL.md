---
name: verify-yard-generation-quota
description: Verify atomic SQLite generation quota reservations, tenant inventory accounting and verified readiness.
---

# Yard generation quota authority

**Properties:** Within one authority database, a new reservation atomically counts all pending generations and a tenant's initial and claimed Yards before accepting a fixed positive limit. A repeated key is bound to the same attempt, tenant, Yard, plan and limits. Uncertain claims remain pending, and a concurrent slot is released only after a trusted verifier accepts readiness bound to the claim; the Yard remains counted for its tenant. Generated placement requires the authority, checks host policy before reserving quota, and binds the stored claim before budget reservation and again at the actual provider call after asynchronous scheduling.

**Review baseline:** commit `3d9ddf95b2738567113427457b47497b5d5750e1`. PASS for the bounded model, integer abstraction and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/generation-quota.ts` initializes a fixed scope, baseline and limits, serializes count-and-reserve with SQLite `BEGIN IMMEDIATE`, validates idempotent claims and verified readiness, and refuses in-memory databases.
- `packages/broker/test/yard-generation-quota.test.ts` checks limits, an over-limit initial inventory, persistence across connections, conflicting identities and settings, readiness binding, memory URIs, 40 generated reserve/ready histories (seed 614597), and two actual worker threads racing for the last slot.
- `packages/broker/src/yard-placement/deploy.ts` checks durable quota availability, reserves after host approval and before the budget hold, rechecks the claim and authority, inspects existing claims instead of provisioning again, and retains exposure when readiness cannot be verified. `packages/broker/src/rejections.ts` catalogs these refusals.
- `packages/broker/test/yard-event-store-folds.test.ts` exercises missing, non-durable, exhausted, mismatched, replaced and unverified quota evidence against real SQLite budget and quota authorities, including 40 generated cases (seed 614598) and a microtask change immediately before the provider call. The local funding suite also runs. The authority is exported by the broker entry points.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-quota
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation or let the check install that pinned version in a temporary directory. Java 11+, Python with pip, Node with SQLite and workspace dependencies are required. Use `/statechart` with the model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardGenerationQuota` explores 13 states and 27 steps for three requests, two tenants, one active slot, a two-Yard tenant cap and one initial Yard. It checks active and tenant bounds and that modeled readiness is verified. Its three-state projection follows the first request and hides 23 same-label steps. Four weakened model guards produce counterexamples. The model assumes its initial inventory is within the cap; actual over-limit baselines are accepted but cannot admit another Yard for that tenant. `YardQuotaAdmission` explores 54 states through authority availability, host policy, quota, budget, authority changes, provider and readiness outcomes. Its twelve-state projection hides 18 same-label steps; five weakened admission guards produce counterexamples.

Z3 proves the stated reserve and completion inequalities over unbounded integers with fixed positive limits, nonnegative counters and a safe starting state. Three weakened premises produce counterexamples. This is an arithmetic abstraction, not proof that TypeScript or SQLite refines it. The real SQLite tests exercise two independent worker threads. Ten authority and nine admission source mutations, run with `python3 .agents/skills/verify-yard-generation-quota/mutations/runtime.py` and `python3 .agents/skills/verify-yard-generation-quota/mutations/admission.py`, each first require a passing control and then a failed assertion; the provider-boundary mutation removes both redundant call-boundary checks.

The host must provide a complete initial inventory, send all later Yard creations through the same database, preserve that database, use the same fixed scope and limits, and supply an honest readiness verifier. The authority does not independently inspect a provider, import pre-existing uncertain operations, reconcile unused reservations, remove deleted Yards, support changing limits in place, or coordinate separate databases. Quota and budget use separate transactions; a failure after quota reservation may retain capacity without a budget hold. Existing claims are inspected rather than re-provisioned. A false readiness assertion, missing initial Yard or out-of-band creation can violate a real-world quota. It does not prove filesystem durability, crash recovery, liveness or TypeScript refinement.

For broken-code checks, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_QUOTA_VERIFY_PACKAGE_ROOT`, and separately disable the concurrent-limit guard, tenant-limit guard and readiness verifier in the copied `generation-quota.ts`. Each full skill run must fail a real assertion. Also run five separate broken copies of `deploy.ts`: bypass both durable-authority checks, bypass the returned-claim binding, bypass both stored-readiness checks, reserve quota before host policy, and disable both the saga authorization check and the pinned connector recheck at the provider boundary. The last is a compound mutation because either check alone refuses the covered race. Each full skill run must fail a real assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the model, integer obligations and tests for intended changes; replay counterexamples against code, test all eight broken scratch implementations and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
