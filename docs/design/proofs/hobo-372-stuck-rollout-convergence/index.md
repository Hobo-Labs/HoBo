# HOBO-372 Stuck Rollout Convergence Proof

This proof connects stuck/partial rollout convergence to:

- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0004](../../adr/01-architecture-core.md#adr-0004)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/stuck-rollout-convergence-contract`](../../../../src/draft/technical-proofs/stuck-rollout-convergence-contract)

Acceptance evidence:

- An unresolved rollout gate crosses its progress deadline and emits `rollout.Failed` plus
  `rollout.RolledBack` instead of remaining `running`.
- A half-applied router flip is detected from observed traffic-split state and rolls back rather
  than trusting provider self-report.
- Orchestrator-death recovery replays the event log, resumes from the current step index, and does
  not duplicate already completed rollout steps.
- A non-convergeable rollback emits `rollout.Failed` with `state: "needs-human"` and one recovery
  action, not an infinite retry loop.
- A single-writer recovery lease prevents two workers from double-driving the same stuck rollout.
- A rollout stuck at 50 percent terminates with a verdict after its deadline.

Scope boundary:

- No happy-path rollout strategy implementation.
- No SLO/metric-analysis calculation.
- No rollback-itself-fails compensation depth beyond the needs-human terminal handoff.
- No gateway provider or traffic-split provisioning.
