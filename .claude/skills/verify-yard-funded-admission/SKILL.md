---
name: verify-yard-funded-admission
description: Verify funded Yard quote and context fencing, retained holds and selected generation-reconciliation paths when changing Yard-first admission.
---

# Funded Yard admission and generation

**Properties:** A funded Yard receipt requires a quote for its selected Yard and provider, an unchanged quote and budget context around policy and reservation, and a current quote and context through receipt issuance. If evidence changes after the durable reservation, the hold remains for reconciliation. Generation must claim funding under current context; on the covered failures after a provider effect, the original hold is marked uncertain, or a failed uncertainty write is reported while the hold remains. A failure can issue a receipt for different or expired liability, provision without valid funding, or leave a provider effect without identified reconciliation.

**Review baseline:** commit `c77179e1005c14b2ca54a7507c72ac484f9592fa`. PASS for the bounded models, symbolic abstraction and generated tests below.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` snapshots Yard quotes and budget, broker, catalog, tenant, policy and authority context; matches the selected Yard and provider; rechecks evidence and freshness across callbacks and reservation; retains committed holds on refusal; and marks the original generation hold uncertain on the covered post-effect failures. The trusted durable authority owns reservation atomicity and balance accounting.
- `packages/broker/src/yard-placement/rejections.ts` records the admission and reconciliation rejection codes. `packages/broker/test/yard-funded-quote-race.test.ts` exercises a real SQLite authority, foreign Yard and provider quotes, mutations around policy and reservation, expiry, final receipt races and 100 generated Boolean combinations (seed 614525). `yard-event-store-folds.test.ts` covers unavailable budget evidence, changed context before claim and after provisioning, failed uncertainty writes, missing residual definitions and unavailable provider signals. `hosting-budget.test.ts` exercises funded admission and settlement integration.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-funded-admission
```

The runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or allow the runner to obtain them. Java 11+, Python, Node, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` with the model and corresponding view to inspect the transitions and any counterexample.

## Scope and evidence

`YardFundedAdmission` explores 274 states over abstract selection, quote and context checks before and after reservation, freshness, the final receipt handoff and retained holds. Its six-state projection hides 128 same-label steps. `YardFundedGeneration` explores 40 states for funding, context at claim, a provider effect, subsequent evidence and uncertainty-write availability. Its six-state projection hides 16 same-label steps. Eight admission and five generation model-guard mutations produce counterexamples. Z3 checks eight guard implications and detects the corresponding weakened premises; those implications assume the guards and do not establish that TypeScript implements them.

The real-code regression suite uses SQLite and exercises independent quote, context, reservation and post-effect mutations. Twenty-two real-code mutations remove guards in an isolated package and require the corresponding real tests to fail. Run them with `python3 .agents/skills/verify-yard-funded-admission/mutations/real-code.py`. The funded quote proof currently names only the quote ID, not its full contents or the selected resource definitions. This skill assumes truthful policy, atomic durable authority and provider evidence; it does not authenticate the host, prove actual provider bills or remote execution, cover every exception after a provider effect, prove TypeScript refinement, or establish liveness. Transport and receiver-side enforcement require separate verification.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_FUNDED_VERIFY_PACKAGE_ROOT`, and remove the policy quote equality check. The real-code test must fail. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
