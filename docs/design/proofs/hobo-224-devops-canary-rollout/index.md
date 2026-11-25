# HOBO-224 DevOps Canary Rollout Proof

HOBO-224 is proven by the focused POC at
[`src/draft/exp-proofs/dx/devops-canary-rollout-journey-contract`](../../../../src/draft/exp-proofs/dx/devops-canary-rollout-journey-contract/README.md).

## Acceptance Evidence

| Acceptance | Executable proof |
|---|---|
| `hobo up --strategy canary` advances traffic through 10%, 50%, and 100% | `runs hobo up --strategy canary through 10/50/100 with health checks, inspect, logs, and audit events` asserts the command, declared rollout policy, traffic steps, and final gateway split. |
| Health checks run between canary steps | The same test asserts a pass decision for each 10%, 50%, and 100% gate and records inspect/log evidence for every step. |
| Healthy rollout reaches 100% and promotes via the same gate | The same test asserts `rollout.status.state === "promoted"`, a 100% target split, and a prod promotion gate verdict of `promote`. |
| Injected guardrail SLO burn auto-reverts to the prior revision without human action | `auto-rolls back to the exact prior revision on a guardrail SLO burn without human action` asserts rollback on SLO burn, `humanActionRequired: false`, and the exact prior revision. |
| `hobo inspect` shows the rollout timeline | The healthy and rollback tests assert the inspect run view contains shift/health/rollback steps reconstructed from rollout events. |
| Every step emits an auditable event | The healthy test asserts the rollout audit log is populated by `run_checkout_canary` events, and `reconstructs promoted rollout state from auditable events only` rebuilds state from those events. |

## Adversarial Evidence

| Adversarial case | Guard |
|---|---|
| Burn mid-step rolls back without stranded split traffic | The SLO burn test asserts the gateway split returns to 100% prior revision and 0% target revision. |
| Flapping SLO does not thrash | `uses hysteresis so a flapping SLO window does not thrash rollout state` asserts min consecutive samples, min dwell evidence, one rollback command, and no promote loops. |
| Aborted rollout never half-promotes | `aborts cleanly without half-promoting and can reconstruct state from the event log` asserts no `rollout.Promoted` event and final rollback state. |
| Rollback target is the exact prior revision | The SLO burn and abort tests assert rollback target `checkout@sha256:blue`, not latest. |
| Step-1 unhealthy canary fails fast | `fails fast when the first canary step cannot get healthy` asserts only the 10% step runs before rollback. |
| Rollout state is reconstructible from events | The replay test asserts `reconstructRolloutState(events)` equals live status and gateway state. |

## Scope Boundary

This branch consumes the existing `hobo up`, `hobo inspect`, deployment-strategy saga, and
SLO promotion-gate contracts. It does not implement flag or experiment harness engines,
SLO metric pipeline internals, rollout controller internals, or manual blue/green tooling.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\devops-canary-rollout-journey-contract test
```
