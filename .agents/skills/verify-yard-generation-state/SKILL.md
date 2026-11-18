---
name: verify-yard-generation-state
description: Verify exact Yard quotes, generation identity, readiness and provider signal batches around funded Yard placement.
---

# Yard generation identity and readiness

**Properties:** An exact Yard quote and a generation plan must name the requested Yard. A provider result must belong to the planned attempt and Yard; a non-ready result needs a ready signal bound to both. A malformed or foreign provider signal batch is refused before any of its events are folded. If a rejection follows a provider effect, the hold is marked uncertain or retained with a reconciliation warning if the uncertainty write fails.

**Review baseline:** commit `ff1ffeb7e381916ca25012f83d2daa56e3f434d3`. PASS for the finite models and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts`: `prepareYardHostingWork` and `resolveBindleDeployment` check exact Yard identity, generation result identity and readiness, validate and privately capture supported normalized provider events, and retain funded exposure on refusal.
- `packages/broker/src/yard-placement/event-store-resolvers.ts`: the local ready normalizer retains the generation attempt ID.
- `packages/broker/test/yard-generation-identity.test.ts`: exact-Yard quote examples, early refusal of a missing exact ID and 100 generated mismatches, seed 614589. The request parser rejects a missing exact ID before the quote check; `verify-yard-request-wire` models that input boundary separately.
- `packages/broker/test/yard-event-store-folds.test.ts`: funded real SQLite and Azure-connector scenarios, including mismatched results, a retry inspected under the original attempt, missing or foreign signals, mutable/forged normalized events, sequence ownership, missing readiness, and failure to write uncertainty. Forty generated foreign-signal cases use seed 614590.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-state
```

The runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Python, Node, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` with each model and its adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardExactQuote` explores 16 states for exact selection, ID presence and matching; its three-state projection hides eight same-label steps. `YardGenerationIdentity` explores 136 states for exact plan, returned Yard and attempt identity, a retained hold and uncertainty-write failure; its eight-state projection hides 32 same-label steps. `YardGenerationReadiness` explores 32 states for a ready result or an attempt-bound ready signal, including a failed uncertainty write; its four-state projection hides 16 same-label steps. `YardSignalBatch` explores 68 states for raw and normalized identity validation, broker-owned event types, private snapshots, stream sequence ownership and refusing the batch without folding part of it; its four-state projection hides 32 same-label steps. Thirteen weakened model guards produce the specified counterexamples.

The executable check runs the real broker fixtures. To exercise individual code guards, run `python3 .agents/skills/verify-yard-generation-state/mutations/runtime.py`; each mutation first requires an unmodified control, then an actual test assertion failure. The mutations cover exact quote and plan checks, provider result identity, uncertainty reporting, readiness, raw and normalized signals, allowed event types, capture, sequencing, batch refusal and the local ready attempt ID.

The models abstract prior policy and quote approval, asynchronous provider behavior, durable storage and concurrent executions. A connector's explicit ready result, provider evidence, normalizer semantics and host-supplied prior events are trusted; the checks do not prove actual remote readiness or TypeScript refinement. They do not establish full event-schema validity, liveness, crash recovery or cross-process atomicity. The related `verify-yard-generation-authority` and `verify-yard-funded-admission` skills check other bounded slices of generation authority and budget admission.

For a broken-code check, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_STATE_VERIFY_PACKAGE_ROOT`, and make `request.yard.requestedYardId !== genDecision.plan.expectedYardId` false in its `deploy.ts`. This skill must fail the real exact-Yard generation assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update models and tests for intended changes, replay counterexamples, test a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
