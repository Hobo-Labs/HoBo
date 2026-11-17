---
name: verify-yard-funded-admission
description: Verify funded Yard quote and context fencing, retained holds and selected generation-reconciliation paths when changing Yard-first admission.
---

# Funded Yard admission and generation

**Properties:** A funded Yard receipt requires a quote for its selected Yard and provider, an unchanged quote and budget context around policy and reservation, a policy proof bound to the complete quote digest and ID, a quote bound to selected resource work and any generation plan, and a current quote and context through receipt issuance. If evidence changes after the durable reservation, the hold remains for reconciliation. Generation must claim funding under current context; on the covered failures after a provider effect, the original hold is marked uncertain, or a failed uncertainty write is reported while the hold remains. A failure can issue a receipt for different or expired liability, provision without valid funding, or leave a provider effect without identified reconciliation.

**Review baseline:** commit `bfc4b86a2601e8acf97100f313b365d191369136`. PASS for the bounded models, symbolic abstraction and generated tests below.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` snapshots Yard quotes and budget, broker, catalog, tenant, policy and authority context; matches the selected Yard and provider; rechecks evidence and freshness across callbacks and reservation; retains committed holds on refusal; and marks the original generation hold uncertain on the covered post-effect failures. Generation checks the plan content against its approved hash before claim and provider operation. The trusted durable authority owns reservation atomicity and balance accounting.
- `packages/broker/src/budget-authority.ts` computes the protobuf JSON SHA-256 quote digest shared by policy admission and durable reservations; the protobuf and CUE policy-proof schema carry the digest and reject unbound proofs at admission.
- `packages/broker/src/yard-placement/rejections.ts` records the admission and reconciliation rejection codes. `packages/broker/test/yard-funded-quote-race.test.ts` exercises a real SQLite authority, foreign Yard and provider quotes, mutations around policy and reservation, expiry, final receipt races and 100 generated Boolean combinations (seed 614525). `yard-event-store-folds.test.ts` covers unavailable budget evidence, changed context before claim and after provisioning, failed uncertainty writes, missing residual definitions and unavailable provider signals. `hosting-budget.test.ts` exercises funded admission and settlement integration. `yard-policy-quote-binding.test.ts` checks legacy and foreign proofs, same-ID quote changes, binary wire round trips, and 100 generated cases (seed 614526). `yard-quote-work-binding.test.ts` checks stale definitions, prices, catalog, request, broker and Yard, with 80 generated cases (seed 614527); generation tests cover changed plans before claim and provider effect, changed work after effect, and separately funded local generation.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-funded-admission
```

The runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or allow the runner to obtain them. Java 11+, Python, Node, CUE, Vitest, fast-check and installed workspace dependencies are required; set `HOBO_CUE_BIN` if CUE is not on `PATH`. Use `/statechart` with the model and corresponding view to inspect the transitions and any counterexample.

## Scope and evidence

`YardFundedAdmission` explores 274 states over abstract selection, quote and context checks before and after reservation, freshness, the final receipt handoff and retained holds. Its six-state projection hides 128 same-label steps. `YardFundedGeneration` explores 40 states for funding, context at claim, a provider effect, subsequent evidence and uncertainty-write availability. Its six-state projection hides 16 same-label steps. `YardPolicyQuote` explores 24 states for two quote contents, matching or foreign IDs, and a legacy unbound proof. Its three-state projection hides 12 same-label steps. `YardQuotedWork` explores 92 states in the generation path for quote/work agreement, plan checks before claim and effect, later work changes and uncertainty writes. Its eight-state projection hides 32 same-label steps. Eight admission, five generation, two quote-proof and six work model-guard mutations produce counterexamples. Z3 checks eight admission guard implications and a quote-binding implication over arbitrary abstract quote values; the latter assumes honest proof binding and collision resistance for the compared quotes. A separate Z3 obligation proves work equality for arbitrary abstract work values under truthful bindings and pairwise collision resistance. Twenty-one weakened symbolic premises produce counterexamples. CUE checks accept a valid policy digest and refuse missing or malformed policy digests; generic non-Yard quotes may omit work digest, while malformed present work digests are refused. These abstractions do not establish that TypeScript implements them.

The real-code regression suite uses SQLite and exercises independent quote, context, reservation and post-effect mutations. Twenty-nine real-code mutations first run a passing unmodified control, then remove guards in an isolated package and require the corresponding running tests to fail; collection errors are refused. Run them with `python3 .agents/skills/verify-yard-funded-admission/mutations/real-code.py`. The quote binds the selected work and generation plan; the callback, provider prices and catalog remain trusted assertions. A changed or revoked generation policy, runtime catalog or connector is not yet fenced by these checks. This skill assumes truthful policy, atomic durable authority and provider evidence; it does not authenticate the host, prove actual provider bills or remote execution, cover every exception after a provider effect, prove TypeScript refinement, or establish liveness. Transport and receiver-side enforcement require separate verification.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_FUNDED_VERIFY_PACKAGE_ROOT`, and remove the policy quote equality check. The real-code test must fail. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
