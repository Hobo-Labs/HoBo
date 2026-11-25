# HOBO-274 Deployment Strategy Saga Templates Proof

This proof connects the M2 deployment-strategy template slice to:

- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [ADR-0004](../../adr/01-architecture-core.md#adr-0004)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/deployment-strategy-saga-templates-contract`](../../../../src/draft/technical-proofs/deployment-strategy-saga-templates-contract)

Acceptance evidence:

- Canary rollouts shift gateway traffic in stages, consume injected SLO-burn and Golden-suite
  signals, emit replayable `rollout.*` events, and roll back to the old version on regression.
- Blue/green rollouts prepare green, evaluate health before the router flip, retain blue through the
  soak window, and replay to the same gateway state.
- Recreate and progressive templates compile provider-agnostic saga steps without provider-specific
  deployment bodies.
- Staged traffic templates reject definitions that cannot reach 100% green before promotion.
- Flapping health signals require hysteresis and fail closed on timeout.
- Half-applied router flips retry the same idempotency key before the step completes.
- Canary gate timeouts between stages roll back to the old version.

Scope boundary:

- No SLO burn-rate computation.
- No Golden-suite execution.
- No deploy-freeze gate.
- No AI live-fix applier.
