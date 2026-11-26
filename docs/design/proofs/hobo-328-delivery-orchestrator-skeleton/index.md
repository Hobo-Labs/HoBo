# HOBO-328 Delivery Orchestrator Skeleton Proof

This proof connects the M1 Harness delivery orchestrator slice to the design
requirements in:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/delivery-orchestrator-skeleton-contract`](../../../../src/draft/technical-proofs/delivery-orchestrator-skeleton-contract)

Acceptance evidence:

- No-op rollout emits `rollout.Started`, gate/step events, and
  `rollout.Promoted`; replay rebuilds the same state.
- Injected gate failure emits the gate decision, `rollout.Failed`, and
  `rollout.RolledBack`.
- A lease-limited run simulates node loss and resumes from the event log at the
  same step index.
- Each executed step has one gate event and one step event.
- Duplicate `rollout.Stepped` delivery for the same `stepIndex` is ignored
  during replay/resume.
- Zero-step rollout promotes immediately with `reason: "no-steps"`.
- Gate hook exceptions fail closed through rollback.

Scope boundary:

- No concrete progressive-delivery strategy templates.
- No SLO metric analysis.
- No traffic-split realization.
- No provider adapters.
