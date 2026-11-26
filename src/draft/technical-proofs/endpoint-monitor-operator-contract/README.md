# Endpoint Monitor Operator Contract POC

Independent POC for HOBO-272.

This package models the Endpoint Monitor slice from
[Plan 40](../../../../docs/design/operators-sre.md#plan-40): synthetic probe and
drift signals are read by a built-in operator principal, SLO burn and alert
facts are emitted, and the resulting SRE-facing signal composes with the
existing SRE skeleton.

Proven behavior:

- failing synthetic probes crossing a burn threshold emit `slo.BudgetBurned`
  and `alert.Fired`, then the existing SRE skeleton opens one Incident.
- probe access records `token.Granted` and `token.Used` evidence that folds into
  `CredentialAudit`.
- flapping probes are grouped by resource/SLO and emit one alert, not one alert
  per blip.
- probes outside the Endpoint Monitor `.allow()` capability set emit
  `token.Denied` and no SLO/alert signal.
- `resource.DriftDetected` is surfaced into the same SRE signal stream when the
  operator has `resource:read:<id>`.

Scope boundary:

- no real network probe execution, external synthetic-check provider adapter,
  SLO engine, drift detector, alert receiver, paging integration, or SRE
  diagnosis/remediation is implemented here.
- the package proves the operator contract seam and event/audit composition
  only.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\endpoint-monitor-operator-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Endpoint Monitor Operator Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
