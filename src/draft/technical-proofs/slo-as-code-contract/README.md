# SLO-as-code contract POC

Independent proof for HOBO-111.

This package defines the `hobo.slo/v1` SLO declaration contract and the `slo.*`
event family used by reliability gates, Harness promotion policy, and SRE
incident triggers. It is intentionally runtime-only and dependency-free: the
parser stands in for the future Zod schema while the checked-in JSON schema and
WIT sketch pin the public contract surface.

## Contract boundaries

- In scope: OpenSLO-aligned SLO declarations, SLI sources, objectives,
  error-budget windows, burn-rate thresholds, `slo.Declared`,
  `slo.BudgetBurned`, `slo.BudgetExhausted`, and the replayable remaining-budget
  projection.
- Consumed but not owned: the telemetry envelope from HOBO-104. This POC validates
  only the minimal envelope boundary needed by SLO events: `type`, stream fields,
  and `meta.traceparent`.
- Out of scope: SLO computation runtime, alert routing, deploy-gate enforcement,
  OTLP/CloudEvents/OCSF exporters, and full telemetry-envelope mapping.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-as-code-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slo As Code Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
