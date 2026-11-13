---
type: Runbook
title: "HoBo.CD runbook: Telemetry and alerts"
description: "Metrics, DORA, alert rules and SLOs. Assembled from the Runbook section of packages/cd/src/telemetry/README.md."
tags: [hobo, cd, runbook, telemetry]
---

# HoBo.CD runbook: Telemetry and alerts

Metrics, DORA, alert rules and SLOs. This page is assembled from the **Runbook** section of `packages/cd/src/telemetry/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **`CdTelemetryExportFailing` / `health().checks.exporter.ok = false`.**
  Read `sink.stats().lastError.code`. `otlp-rejected` with 401/403: rotate the
  collector credential in the composed `headers`. `otlp-retries-exhausted`:
  the collector is down or saturated; delivery continues, telemetry is
  dropped (not buffered) until it recovers.
- **`CdReconcileLagHigh`.** Check the Camp's `camp.condition` gauges:
  `reachable=false` means the agent stopped polling (see the feed runbook);
  `leased=false` means no reconciler holds the Camp lease. If both are true,
  inspect `deployment.ReconcileBlocked` on `cd-camp-status-<camp>`.
- **`CdChangeFailureRateHigh`.** Query `dora({ windowMs, campIds })` per
  Camp to find where rollbacks cluster; inspect the verification results
  of the rolled-back promotions.
- **`CdFanoutFailuresPresent` / fan-out halted.** The fan-out halts at its
  failure budget (I20); resume or roll back with `fanout.resume` /
  `fanout.rollback` (both authorized).
- **`CdFailoverInProgress`.** A governed failover is still replacing after the
  grace period; check the replacement Camp's verification. The source is
  kept until the replacement qualifies (I21).
- **`CdInformNoncompliantRatioHigh` / `CdShadowDivergence`.** The candidate
  Rail will not qualify under R12. Read the compliance heatmap (yard-world)
  for the failing controls, fix the Rail or acknowledge the expected
  divergence in its node's `VerificationSpec`.
- **`CdCredentialExpiring`.** An agent's SVID is not refreshing; check the
  agent's clock and its reach to the Station feed.
- **`health().checks.journal.ok = false`.** The event store is unreadable;
  DORA and lag queries throw until it recovers. Check store health.
- **Upgrading semantic conventions.** Bump `STANDARDS.lock.json` and
  `SEMCONV`, regenerate `test/telemetry/semconv-registry.ts` from the new
  tag, and keep the golden tests green.
