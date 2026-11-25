# SRE Operator Skeleton Contract POC

Independent POC for HOBO-270.

This package models the first SRE operator loop from
[Plan 40](../../../../docs/design/operators-sre.md#plan-40): subscribed operational
signals enter the built-in SRE service, a `crew.AgentDispatched` fact is emitted,
and correlated signals open one `incident.Opened` aggregate event.

Proven behavior:

- `slo.BudgetBurned` dispatches the SRE operator and opens exactly one Incident.
- multiple correlated `alert.Fired` signals fold into the same Incident.
- duplicate correlated alerts against an existing Incident do not dispatch or open again.
- `sre.mttd` is recorded from signal occurrence to `crew.AgentDispatched`.
- an alert storm on one root cause opens one Incident, not N incidents.
- an unknown signal type is logged and escalated with `crew.HandoffRequested`.
- the SRE principal exposes the built-in reasoning engine port and a HolmesGPT adapter stub seam.

Scope boundary:

- no diagnosis, classification, runbook selection, remediation, paging integration, or real
  HolmesGPT invocation is implemented here.
- `alert.*` is exposed as the subscription pattern, while `alert.Fired` is the concrete
  incident-opening signal currently accepted by the incident aggregate contract.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\sre-operator-skeleton-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sre Operator Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
