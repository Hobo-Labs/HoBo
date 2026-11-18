---
name: verify-yard-generation-quota
description: Verify durable Yard quota admission, execution fencing, cancellation and upgrade.
---

# Yard generation quota authority

**Properties:** Within one authority database, admission atomically counts pending generations and a tenant's initial and claimed Yards against fixed positive limits. A repeated key is bound to the attempt, tenant, Yard, plan and limits. A pending reservation can be cancelled only before its durable execution fence is claimed; cancellation leaves a request-bound tombstone and the key cannot be reused. Only the caller that newly claims the fence may provision. A claimed or uncertain attempt remains counted until trusted, bound readiness evidence is verified. Generated placement checks host policy before quota and rechecks the quota authority and persisted fence at the provider boundary.

**Review baseline:** commit `b79a7d7ab3c7a048c88eba1ab9f2d806ad6a4c6b`. PASS for the bounded models, integer abstraction and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/generation-quota.ts` uses SQLite `BEGIN IMMEDIATE` to serialize fixed-scope count-and-reserve, identity-bound claims and cancellation, keeps cancellation tombstones, and validates readiness. Upgrade checks scope and baseline before fencing all legacy claims and installing write guards for older connections.
- `packages/broker/test/yard-generation-quota.test.ts` checks limits, initial inventory, persistence, conflicting identities, readiness binding after the execution claim, in-memory database refusal, 40 generated reserve/ready histories (seed 614597) and two real workers racing for capacity. `packages/broker/test/yard-generation-quota-release.test.ts` checks 40 generated reserve/claim/cancel histories (seed 614602), key non-reuse, identity, actual two-worker claim/cancel and claim/claim races, wrong-scope upgrades and already-open older writers.
- `packages/broker/src/yard-placement/deploy.ts` reserves quota after host approval and before the budget hold, claims and verifies the durable execution fence, inspects existing claims, and attempts to cancel its own unused reservation on pre-fence failure. It verifies the bound cancellation result, tombstone and absent claim; a lost quota or budget acknowledgement or unverifiable cancellation requires reconciliation. `packages/broker/src/rejections.ts` catalogs refusals.
- `packages/broker/test/yard-event-store-folds.test.ts` exercises real SQLite budget and quota authorities, missing and changed evidence, admission order, false fence and cancellation acknowledgements, committed and uncommitted lost quota or budget acknowledgements and 40 generated cases (seed 614598), including changes at the provider boundary. The local funding suite also runs. The authority is exported by the broker entry points.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-quota
python3 .agents/skills/verify-yard-generation-quota/mutations/runtime.py
python3 .agents/skills/verify-yard-generation-quota/mutations/admission.py
python3 .agents/skills/verify-yard-generation-quota/mutations/release.py
python3 .agents/skills/verify-yard-generation-quota/mutations/full.py
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation or let the check install that pinned version in a temporary directory. Java 11+, Python with pip, Node with SQLite and workspace dependencies are required. Use `/statechart` with the models and adjacent views to inspect transitions and counterexamples.

## Scope and evidence

`YardGenerationQuota` explores 13 states and 27 steps for three requests, two tenants, one active slot, a two-Yard tenant cap and one initial Yard. It checks active and tenant bounds and modeled readiness. Its three-state projection follows the first request and hides 23 same-label steps. Four weakened model guards produce counterexamples. This older model abstracts the quota execution claim and cancellation; use the models below for those transitions. It assumes the initial inventory is within the cap; actual over-limit baselines cannot admit another Yard for that tenant.

`YardQuotaAdmission` explores 74 states and 92 steps through authority presence, host policy, quota, budget, execution fencing, cancellation, provider and readiness outcomes. Its 16-state projection hides 38 same-label steps. Seven weakened guards produce counterexamples. The prior properties `budgetHeld => quotaHeld` and `uncertain => quotaHeld /\ budgetHeld /\ ~quotaReady` are deliberately retained as expected counterexamples: after the budget hold, an unclaimed quota reservation may be cancelled while budget exposure needs reconciliation. The real `generation-quota-claim-fails` test covers this case with no provider call. The checked replacement requires a retained quota or a recorded release for held budget, and retains both exposures for uncertain claimed work. Unverifiable cancellation models both a retained quota and an actually released quota whose evidence is unavailable. Lost reservation acknowledgements model both committed and uncommitted outcomes, require reconciliation to be reported and stop budget and provider effects. This model abstracts the budget execution claim; `verify-yard-funded-admission` checks that claim and its observed evidence separately. Policy and quota-limit facts are fixed in this model, and authority changes are modeled only before the provider call; separate generation-authority and saga skills cover other slices.

`YardQuotaRelease` checks eight states and ten steps for two abstract workers racing to claim or cancel one reservation. Its five-state projection hides three same-label steps. `YardQuotaMigration` checks eight states and 16 steps for an upgrade, a wrong-scope attempt and an old writer; its two-state projection hides 12 same-label steps. Three weakened guards in each model yield counterexamples. The release model assumes each unique winner calls at most once; it does not prove this behavior for an arbitrary provider or cross-process host. The migration models the guarded SQLite upgrade as an atomic transition.

Z3 proves the reserve, verified completion and cancellation inequalities over unbounded integers with fixed positive limits, nonnegative counters and a safe starting state. Cancellation assumes a positive active and tenant count and an unclaimed reservation. Five weakened premises produce counterexamples. This is an arithmetic abstraction, not a proof that TypeScript or SQLite refines it. The real source-mutation scripts require passing controls and failed assertions for ten authority, nine admission and thirteen cancellation/upgrade variants. The readiness-tenant mutation removes both identity checks, the provider-boundary mutation removes both redundant call-boundary checks, and one cancellation-evidence mutation removes both tombstone and absent-claim checks; each check alone protects its covered case.

The host must provide a complete initial inventory, send all later Yard creations through the same database, preserve it, use the same fixed scope and limits, and supply honest policy and readiness evidence. A typed quota denial must mean that the call did not create a reservation; other reservation errors may have committed. SQLite transactions and stored data are trusted. Older application code is assumed not to alter the internal permit table or guards maliciously. Quota and budget are separate transactions; budget holds and pre-existing stranded unclaimed reservations may require reconciliation, and hosts can explicitly cancel the latter after checking their bound attempts. Claimed uncertain work and deleted Yards have no automatic reconciliation here. Different databases, out-of-band creations, false evidence, missing inventory, crash durability, liveness and TypeScript refinement remain outside the guarantee.

The full mutation runner copies `packages/broker` to isolated scratch packages, runs each broken implementation, and checks the restored implementation afterward. It separately disables the concurrent-limit guard, tenant-limit guard and readiness verifier. Separately bypass both durable-authority checks, returned-claim binding, both stored-readiness checks, policy-before-quota ordering, and both call-boundary authorization checks. Also separately disable the cancellation fence, cancelled-key guard, unique execution claim, legacy-claim fence, old-writer update guard, persisted execution recheck, tombstone recheck, lost-budget-acknowledgement detection and lost-quota-acknowledgement detection. Each of these 17 full skill runs must fail a real assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models, integer obligations, tests and flow projections for intended changes; replay counterexamples against code, run all source mutations and the 17 broken scratch implementations, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
