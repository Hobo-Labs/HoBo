# Dogfood Yard Acceptance Contract

HOBO-403 proof for Dogfood Yard M0 acceptance scenarios and telemetry evidence.

## What This Proves

- Dogfood Yard has explicit personas for platform engineers, hosted operations, SRE/support, and
  release readiness.
- Hosted and self-hosted Yard acceptance scenarios are listed without building Yard runtime code.
- Required evidence channels are machine-checkable: logs, traces, status views, support/debug
  bundles, and rollback signals.
- Evidence ownership maps to operational, admin, bootstrap, and reliability project boundaries.
- Scope validation rejects Yard build work, live provider calls, customer data, and beta/GA
  readiness claims in this M0 issue.
- Follow-up M1-M4 evidence work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 acceptance record. It does not build the Yard, provision live cloud
resources, call production provider APIs, store credentials, or use live customer data.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\dogfood-yard-acceptance-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Dogfood Yard Acceptance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
