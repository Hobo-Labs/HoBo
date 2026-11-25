# Delivery Orchestrator Skeleton Contract

Independent POC for HOBO-328. It pins the Harness delivery orchestrator state
machine over `hobo:delivery` rollout events without implementing concrete
canary/blue-green templates, SLO metric analysis, traffic-split realization, or
provider adapters.

The contract proves:

- A no-op rollout drives `rollout.Started` to per-step gate/step events and
  `rollout.Promoted`, then replays to the same live state.
- A failing gate emits the gate decision, then `rollout.Failed` and
  `rollout.RolledBack`.
- A lease-limited run can stop mid-rollout, replay the event log, and resume at
  the next step without duplicating earlier steps.
- Every executed step has both a `rollout.GateEvaluated` and a
  `rollout.Stepped` audit event.
- Duplicate step delivery is memoized by `stepIndex`.
- Zero-step rollouts promote immediately with an auditable `no-steps` reason.
- Gate hook exceptions fail closed to rollback instead of leaving the rollout
  stuck.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\delivery-orchestrator-skeleton-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Delivery Orchestrator Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
