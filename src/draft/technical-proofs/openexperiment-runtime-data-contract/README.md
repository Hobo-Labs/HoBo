# OpenExperiment runtime data POC

Independent POC for HOBO-349. It proves the runtime data-collection half of the
Harness experiment leg without implementing statistical analysis or adapters.

## Scope

- Deterministic assignment from a percentage or multivariate experiment flag.
- First-assignment pinning so allocation changes do not silently re-bucket an
  already assigned subject.
- `experiment.Assigned` and `experiment.Exposed` event-log records with sampled
  population markers.
- Exposure recording only when the assigned variant affects behavior.
- Exposure idempotency by `(experiment, subject)`.
- Metric references joined to the event log and W3C `traceparent` data.
- Guardrail that rejects sampled exposure streams when a downstream reader asks
  for full traffic.

## Out of scope

- `experiment.Concluded` and statistical-analysis surfaces.
- Peeking or p-hacking guardrails.
- Provider adapters.
- Eval/training-engine integration.

## Verification

```powershell
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Openexperiment Runtime Data Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
