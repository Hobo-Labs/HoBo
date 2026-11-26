# HOBO-292 Autonomous Drift Remediation Proof

This branch proves the Operators/SRE drift-remediation slice as an independent draft contract:
[`src/draft/technical-proofs/autonomous-drift-remediation-contract`](../../../../src/draft/technical-proofs/autonomous-drift-remediation-contract).

## Acceptance Mapping

| Issue requirement | Executable proof |
|---|---|
| Consume `resource.DriftDetected` and classify Drift | `handleResourceDrift()` validates the signal and uses the existing failure-taxonomy classifier. |
| `heal` resource auto-resyncs as a gated canary | `auto-resyncs a heal resource through the gated canary path` routes a `resync` action through `applyGatedRemediation()` and observes `rollout.Promoted`. |
| `propose` resource opens a gated diff | `opens a gated diff for a propose resource without applying the resync` emits `policy.Decided=require-approval`, `crew.ActionProposed`, and `drift.DiffProposed`, with no rollout. |
| `ignore` resource records drift without acting | `records ignored drift and emits no write action` emits only `drift.Ignored`. |
| Repeated drift does not oscillate | `does not oscillate on repeated drift for the same desired and observed refs` escalates via `crew.HandoffRequested`. |
| Blast-radius overflow escalates | `escalates when a drift resync would exceed the blast-radius budget` enters A2H and skips rollout. |

## Scope Boundaries

The POC does not implement drift detection, polling, provider refresh, ResourceActor reconcile
internals, or the Control Plane drift scheduler. It consumes the drift signal and existing
classifier/gated-remediation contracts only.
