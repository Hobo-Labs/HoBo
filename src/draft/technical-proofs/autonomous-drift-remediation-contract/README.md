# Autonomous drift remediation contract

Independent POC for HOBO-292. It consumes `resource.DriftDetected`, classifies it through the
existing failure-taxonomy classifier, applies a per-resource drift policy, and then either:

- `heal`: creates a `resync` RemediationAction and routes it through the gated live-fix canary path.
- `propose`: opens an event-sourced gated diff without applying the resync.
- `ignore`: records the drift as observed without emitting a write action.

The package intentionally does not implement drift detection, drift scheduling, ResourceActor
reconcile internals, or provider refresh behavior. Those remain owned by the Control Plane and
provider contracts.

Proofs:

- heal resources use the existing `applyGatedRemediation` path and emit `drift.RemediationRouted`.
- propose resources emit `policy.Decided=require-approval`, `crew.ActionProposed`, and
  `drift.DiffProposed`, with no rollout or action-applied event.
- ignore resources emit only `drift.Ignored`.
- repeated drift for the same resource and same desired/observed refs escalates instead of
  re-applying the same resync loop.
- high-impact drift resyncs that exceed the blast-radius budget enter A2H escalation.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Autonomous Drift Remediation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
