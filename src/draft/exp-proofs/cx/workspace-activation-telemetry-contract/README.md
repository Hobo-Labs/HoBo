# Workspace Activation Telemetry Contract

HOBO-486 defines the M0 contract for first-run workspace activation telemetry.

## What This Proves

- Required first-run activation events cover account creation, workspace creation, project creation,
  first plan, first deploy attempt, first failure recovery, and first successful handoff.
- Every event maps to a product question and support or recovery use before M1 implementation.
- Privacy rules define purpose limits, retention, opt-out/export behavior, and PII or secret
  exclusions.
- Scope guards reject live analytics vendor selection, broad behavioral tracking, and raw PII or
  secret capture.

## Boundary

This package validates the M0 contract. It does not build product UI, event ingestion, storage,
analytics vendor integration, customer-success profiling, or a telemetry pipeline.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\workspace-activation-telemetry-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Workspace Activation Telemetry Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
