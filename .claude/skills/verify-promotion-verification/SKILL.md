---
name: verify-promotion-verification
description: Check the promotion saga's fail-closed verification and qualification path.
---

# Release promotion verification

**Property:** A promotion may qualify a release only after verification passes. A request using an existing promotion or rollback key must match the recorded binding before it is acknowledged or advanced.

**Why:** An inconclusive or failed verification must not make a release eligible for later environments, and a different request must not be mistaken for an earlier operation.

**Result at sync commit `0c64d14db561bca28f080aa15e8f56027019bffa`:** PASS for the bounded model and generated real-code cases.

## Covered code

- `packages/cd/src/promotion/service.ts`
- `packages/cd/src/promotion/state.ts` and `packages/cd/src/promotion/journal.ts`
- `packages/cd/test/promotion/promotion.test.ts`
- `packages/cd/test/promotion/verification.property.test.ts`
- `packages/cd/test/promotion/request-binding.property.test.ts` and `request-binding-sqlite.test.ts`

## Run

From the repository root:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-promotion-verification
```

The command runs focused existing real-code Vitest scenarios, fast-check generated cases, TLC 1.7.4, and a Z3 4.15.4 induction proof. Set `TLA2TOOLS` to its jar or let the command download and check it. It needs Java 11+, Python, Node with the repo's `tsx`, Vitest and fast-check, `curl`, and `sha256sum`. Set `BUDGET_Z3_PYTHONPATH` to the pinned solver or allow a temporary installation. Read TLA+ results with `/statechart` using the view in `models/`.

## Scope and evidence

The model has one promotion and one target, abstracting gate, approval, rollout, verification, qualification, and compensation. Pending verification stutters; FAIL and INCONCLUSIVE share the failure path. The real-code checks cover a multi-provider success and an inconclusive result that must not qualify and must restore the predecessor. The generated property uses seed 614443 and 100 cases with 1–4 Camps and varying PASS, FAIL and INCONCLUSIVE results; it records qualification requests before the freight test double can reject a bad one, checks success when all pass, and checks compensation to prior Freight when any fails. The model does not prove retries, journal recovery, group fan-out, provider behavior, or that compensation always succeeds. Disabling the pass-only verdict guard in a scratch copy makes both the direct and generated real-code checks fail.

A Z3 induction proves that an abstract atomic, stable single-key claim preserves matching acknowledgements for any number of requests. It assumes collision-free identities and atomic journal operations and is not a TypeScript refinement or external-effect proof. Setting `PROMOTION_PROOF_MUTATION=omit-binding-check` produces a counterexample.

PromotionBinding checks 28 states and 70 steps for two different requests racing for one key. It requires an acknowledged or advanced request to match the journal, and a rejected request to differ. It assumes atomic empty-stream claim, durable envelope metadata, and collision-free fingerprints. The chart projects four states and three arrows and hides 59 same-label steps. The model abstracts authorization, input normalization, provider effects, result append, and multiple workers retrying the same identity; it is not an exactly-once proof.

Actual-code properties use seeds 614453 and 614454 for 100 generated sequential and concurrent request cases each, plus focused preview and rollback races and injected journal failures. A SQLite integration closes and reopens the event store before exercising promotion and rollback retries. Removing the post-append promotion check or the pre-effect rollback binding in scratch copies fails the corresponding race test. TLC mutations accepting every request or rejecting every request violate independently stated invariants. Historical promotion records are compared using available fields and can refuse ambiguous retries; historical rollbacks without a binding are refused. RollbackRetry checks five states for an atomic Set-changing rollback effect and a changed-current-Set guard; removing that guard permits a second modeled Set change. An injected result-append failure reproduces the actual retry hazard and the fixed code refuses to repeat it after the Set changes. Another fixture changes the Set between the initial check and rollback preparation; the service refuses rather than undoing that newer Set. The desired-state port must still enforce the Delta base atomically through apply. Concurrent retries of the same operation, Rail effects that do not change the Set, and effects completed before a failed result append still require reconciliation and are not fully fenced.

## Keep in sync

Before trusting a result, inspect changes to the covered files since `0c64d14db561bca28f080aa15e8f56027019bffa`, including uncommitted changes. Update model and code check for intentional behavior changes and replay counterexamples against real code. Rerun and demonstrate a broken scratch variant, then advance the sync commit only after confirming that the model describes the code. Use `/maintain-formal-verification-skill` for the update.
