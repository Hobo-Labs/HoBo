---
name: verify-promotion-verification
description: Check the promotion saga's fail-closed verification and qualification path.
---

# Release promotion verification

**Property:** A promotion may qualify a release only after verification passes. A request using an existing promotion or rollback key must match the recorded binding before it is acknowledged or advanced. A rollback attempt may start an effect only with its own matching durable execution claim and the request captured before authorization.

**Why:** An inconclusive or failed verification must not make a release eligible for later environments, and a different request must not be mistaken for an earlier operation.

**Result at sync commit `18a1123ee755f57d5a31999f5541d72e6fe74a85`:** PASS for the bounded models, symbolic abstractions and generated real-code cases described below.

## Covered code

- `packages/cd/src/promotion/service.ts`
- `packages/cd/src/promotion/state.ts` and `packages/cd/src/promotion/journal.ts`
- `packages/cd/data-models/promotion.cue`
- `packages/cd/test/promotion/promotion.test.ts`
- `packages/cd/test/promotion/verification.property.test.ts`
- `packages/cd/test/promotion/request-binding.property.test.ts` and `request-binding-sqlite.test.ts`
- `packages/cd/test/promotion/rollback-execution.test.ts` and `fleet-policy.test.ts`

## Run

From the repository root:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-promotion-verification
python3 .agents/skills/verify-promotion-verification/mutations/full.py
```

The first command runs focused real-code Vitest scenarios, fast-check generated cases, TLC 1.7.4, two Z3 4.15.4 abstractions, and weakened-model checks. The second checks eight broken scratch implementations through the full skill and then reruns the restored code. Set `TLA2TOOLS` to its jar or let the command download and check it. It needs Java 11+, Python, Node with the repo's `tsx`, Vitest and fast-check, `curl`, and `sha256sum`. Set `BUDGET_Z3_PYTHONPATH` to the pinned solver or allow a temporary installation.

With `PSTACK_DIR` set to the pstack checkout, regenerate the rollback execution projection with `/statechart`:

```sh
"$PSTACK_DIR/skills/statechart/scripts/statechart" .agents/skills/verify-promotion-verification/models/RollbackExecutionFence.tla --config .agents/skills/verify-promotion-verification/models/RollbackExecutionFence.cfg --view .agents/skills/verify-promotion-verification/models/rollback-fence-view.mts --out /tmp/hobo-rollback-execution-chart
```

## Scope and evidence

The model has one promotion and one target, abstracting gate, approval, rollout, verification, qualification, and compensation. Pending verification stutters; FAIL and INCONCLUSIVE share the failure path. The real-code checks cover a multi-provider success and an inconclusive result that must not qualify and must restore the predecessor. The generated property uses seed 614443 and 100 cases with 1–4 Camps and varying PASS, FAIL and INCONCLUSIVE results; it records qualification requests before the freight test double can reject a bad one, checks success when all pass, and checks compensation to prior Freight when any fails. The model does not prove retries, journal recovery, group fan-out, provider behavior, or that compensation always succeeds. Disabling the pass-only verdict guard in a scratch copy makes both the direct and generated real-code checks fail.

A Z3 induction proves that an abstract atomic, stable single-key claim preserves matching acknowledgements for any number of requests. It assumes collision-free identities and atomic journal operations and is not a TypeScript refinement or external-effect proof. Setting `PROMOTION_PROOF_MUTATION=omit-binding-check` produces a counterexample.

PromotionBinding checks 28 states and 70 steps for two different requests racing for one key. It requires an acknowledged or advanced request to match the journal, and a rejected request to differ. Promotion fingerprints preserve target order because it controls saga execution order. It assumes atomic empty-stream claim, durable envelope metadata, and collision-free fingerprints. The chart projects four states and three arrows and hides 59 same-label steps. The model abstracts authorization, input normalization, provider effects, result append, and multiple workers retrying the same identity; it is not an exactly-once proof.

Actual-code properties use seeds 614453 and 614454 for 100 generated sequential and concurrent request cases each, plus focused target-order, preview and rollback races and injected journal failures. A SQLite integration closes and reopens the event store before exercising promotion and rollback retries. The executable mutation harness weakens the verification guard, post-append promotion binding, rollback binding, current-Set guard, and target-order binding; every focused real-code check produces a counterexample and the restored implementation passes. Four TLA+ mutations violate `QualificationRequiresPass`, `NoFalseAcknowledgement`, `NoFalseRejection`, or `NoSecondSetChange`. The proof mutation omits the identity guard and produces a Z3 counterexample. Historical promotion records are compared using available fields and can refuse ambiguous retries; historical rollbacks without a binding are refused. RollbackRetry checks five states for an atomic Set-changing rollback effect and a changed-current-Set guard. An injected result-append failure reproduces the actual retry hazard and the fixed code refuses to repeat it after the Set changes. Another fixture changes the Set between the initial check and rollback preparation; the service refuses rather than undoing that newer Set. The desired-state port must still enforce the Delta base atomically through apply. Concurrent retries of the same operation, Rail effects that do not change the Set, and effects completed before a failed result append still require reconciliation and are not fully fenced.

`RollbackExecutionFence` checks 74 states and 184 steps for two attempts on one rollback key, an unfinished legacy claim, lost or forged responses and a durable current-protocol token. It checks that at most one modeled attempt starts an effect, that an effect has the matching stored and returned token, and that unfinished legacy claims do not authorize effects. The six-state projection has four arrows and hides 158 same-label steps, including competing and forged responses. Mutations of the atomic unique-claim assumption and the stored-token, returned-token and legacy guards each yield a counterexample. `RollbackRequestSnapshot` checks five states for a caller changing input after authorization; disabling the snapshot yields a counterexample. These are finite models, not proofs that the TypeScript implementation refines them.

The execution-owner Z3 proof checks abstract token equality for arbitrary strings: distinct attempt tokens, one immutable stored token, and matching response and protocol guards imply that two attempts cannot both start. Dropping each required assumption or guard yields a counterexample. It assumes the journal's atomic uniqueness and truthful stored observations; it does not prove the journal, providers, cross-key coordination, result recovery or liveness. Real tests cover overlapping Rail attempts, two SQLite connections, reopening after result loss, forged or changed returned claims, legacy claims, and generated pre-commit or lost-acknowledgement failures using seed 614603 and 30 cases. A successful observation can become stale if the trusted store violates its append-only claim contract. All workers must honor the new protocol. A claim may remain unresolved even when no effect occurred, so operators must reconcile before new work. Concurrent promotion attempts, different rollback keys and changes to the same Camp still require separate coordination.

## Keep in sync

Before trusting a result, inspect changes to the covered files since the sync commit, including uncommitted changes. Update models and code checks for intentional behavior changes and replay counterexamples against real code. Run all eight broken scratch variants and the restored skill before advancing the sync commit. Use `/maintain-formal-verification-skill` for the update.
