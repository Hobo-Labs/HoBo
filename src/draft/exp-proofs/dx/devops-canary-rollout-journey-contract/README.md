# HOBO-224 DevOps Canary Rollout Journey Contract

Independent POC for HOBO-224. The package proves the DevOps-facing journey where
`hobo up --strategy canary` consumes a rollout declared as code, advances a production
canary, exposes progress through inspect/log projections, and auto-rolls back on SLO burn.

## Scope

- In scope: CLI journey contract, canary step proof, SLO-burn rollback proof, inspect/log
  projection evidence, audit event reconstruction, and adversarial rollback guards.
- Out of scope: flag or experiment engines, SLO metric pipeline internals, rollout controller
  internals, and manual blue/green tooling.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\devops-canary-rollout-journey-contract test
```

## Acceptance Coverage

- Healthy `hobo up --strategy canary` runs the declared 10%, 50%, and 100% rollout,
  verifies health between every step, reaches 100%, and promotes through the prod gate.
- Guardrail SLO burn rolls back automatically to the exact prior revision with no human action
  and no stranded split traffic.
- `hobo inspect` and log projections are generated from the same audit event stream used for replay.
- Flapping SLO windows, aborted rollout, and step-1 unhealthy canary paths fail closed.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Devops Canary Rollout Journey Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
