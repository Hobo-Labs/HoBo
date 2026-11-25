# HOBO-337 Rollout Gateway Traffic-Split Proof

This proof connects canary, blue/green, and progressive rollout saga templates to:

- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0035](../../adr/07-portability-extensibility.md#adr-0035)

Executable artifact:

- [`src/draft/technical-proofs/deployment-strategy-saga-templates-contract`](../../../../src/draft/technical-proofs/deployment-strategy-saga-templates-contract)

Acceptance evidence:

- Canary rollouts shift an injected percentage, evaluate a gate after each split, and auto-promote
  when all gates pass.
- Blue/green rollouts prepare green, health-gate the router flip, retain blue for instant rollback,
  and optionally reap blue only after a passing soak gate.
- Progressive rollouts execute 1%, 10%, 50%, and 100% traffic stages with a gate after every split.
- Failing gates emit `rollout.Failed` and `rollout.RolledBack` compensation events.
- Half-applied router flips retry idempotently and roll back when the gateway cannot converge.
- Held gateway traffic-split acquisition emits a non-advancing gate event and resumes at the same
  stage on replay.

Scope boundary:

- No SLO or metric-analysis computation; gate decisions are injected.
- No experiment assignment or cohorting.
- No Argo, Flagger, Spinnaker, or provider adapter implementation.
