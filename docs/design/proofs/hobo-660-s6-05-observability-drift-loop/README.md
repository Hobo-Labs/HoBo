---
type: Reference
title: "HOBO-660 S6-05 Observability Drift Loop Proof"
description: "Source issue: HOBO-660."
tags: [hobo, design]
---

# HOBO-660 S6-05 Observability Drift Loop Proof

Executable proof record for the observability plane (NFR-014): OTel logs/traces/metrics
with OTLP export, SLO burn-rate alerting, and the drift loop (periodic resync with
heal/propose/ignore surfaced via `hobo drift` and MCP `get_drift`/`heal`).

## Branch Evidence

- Issue: [HOBO-660](https://linear.app/quickdeploy-ai/issue/HOBO-660)
- Design source: [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- Draft package:
  [`src/draft/technical-proofs/s6-05-observability-drift-loop-contract`](../../../../src/draft/technical-proofs/s6-05-observability-drift-loop-contract/README.md)
- Focused gate:
  `pnpm --prefix src/draft/technical-proofs/s6-05-observability-drift-loop-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Deploy and run traces export through OTLP in E2E lane. | `exportControlAndDataPlaneTelemetry` + E2E acceptance lane |
| Seeded SLO burn fires an alert. | `evaluateSloBurnAlert` emits `slo.BudgetBurned`, `alert.Fired`, `alert.Routed` |
| Injected provider drift detected and healed with `drift.*` events. | `runDriftLoop` + `resource.DriftDetected` + `drift.RemediationRouted` |
| Periodic resync tick + MCP `get_drift`/`heal`. | `runDriftSchedulerTick`, `getDrift`, `healDrift` |

## Adversarial Coverage

- Healthy SLO samples do not emit burn alerts.
- `propose` drift policy opens `drift.DiffProposed` without auto-heal.
- `ignore` drift policy emits only `drift.Ignored`.

## Maintenance Note

2026-07-02: Draft POC on branch `cursor/hobo-660-hobo-agent-workflow-af1c`; blocker
HOBO-657 (S6-02) Done — production promotion to `packages/cloud` observability plane
remains follow-up per stage-6 acceptance scope.
