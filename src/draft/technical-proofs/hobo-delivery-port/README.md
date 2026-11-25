# HoBo Delivery Port POC

Independent POC for HOBO-301. It defines the `hobo:delivery` WIT port for an
OpenDelivery-shaped rollout provider and a small in-memory contract harness for
the rollout event family.

## Scope

- WIT package `hobo:delivery@0.1.0` with `start`, `step`, `promote`,
  `rollback`, `abort`, and `status` provider operations.
- Promotion policy descriptor with strategy, ordered rollout steps, analysis
  window, and required adapter capabilities.
- Rollout event envelope for `rollout.Started`, `rollout.Stepped`,
  `rollout.Promoted`, `rollout.RolledBack`, and `rollout.Failed`.
- CDEvents boundary mapping that preserves the internal rollout event payload.
- No-op adapter harness for acceptance tests only.

Out of scope: production rollout sagas, traffic split realization, SLO gate
wiring, and provider adapters.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-delivery-port test
```

The package test regenerates TypeScript bindings from WIT with `jco`, then runs
the acceptance tests for event validation, replay, CDEvents round-trip behavior,
capability warnings, abort failure semantics, and idempotent promotion.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Delivery Port.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
