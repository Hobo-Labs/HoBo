# SRE Diagnose Projection Contract POC

Independent POC for HOBO-276.

This package models the read-only SRE diagnose step from
[Plan 40](../../../../docs/design/operators-sre.md#plan-40): an opened Incident is
diagnosed by executing runbook `diagnose` reads against projections, then
emitting `incident.RootCauseIdentified` when evidence is sufficient.

Proven behavior:

- an open Incident diagnosed from `slo_status`, `tail_logs`, and `get_drift`
  projection snapshots emits `incident.RootCauseIdentified`.
- from-zero replay over the original Incident events plus the diagnosis event
  rebuilds the same root cause.
- a diagnosis engine that attempts to write during the read-only phase receives
  `capability.Denied`, emits no root-cause event, and requests human handoff.
- stale or missing projections produce `insufficient-evidence` and a handoff,
  never a guessed root cause.

Scope boundary:

- no classify/decide branch, remediation proposal, runbook execution engine,
  paging integration, real HolmesGPT invocation, projection engine, or MCP
  server is implemented here.
- the package proves the deterministic diagnose contract and read-only
  projection seam only.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\sre-diagnose-projection-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sre Diagnose Projection Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
