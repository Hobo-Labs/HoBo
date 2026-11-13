# `@hobo/cd/telemetry` — DORA, CI/CD semconv, fleet metrics, OTLP export

Owner: WP19 (plan 0024, C13, D17, R8). Export: `@hobo/cd/telemetry`.

## What is here

| File | Role |
|---|---|
| `STANDARDS.lock.json` | Pinned OpenTelemetry semantic-conventions release (**v1.41.0**, R8). `semconv.ts` and the test registry snapshot must name the same version. |
| `semconv.ts` | Attribute keys (`cicd.pipeline.*`, `cicd.pipeline.run.*`, `cicd.pipeline.task.*`, `cicd.pipeline.result`, `deployment.environment.name`, `hobo.freight.id`, `hobo.camp.id`, …), metric names (`cicd.*`, `hobo.cd.*`). Wire contract. |
| `spans.ts` | Promotion → spans: a pipeline run `RUN <pipeline>` (SERVER) and one task run `promote <campId>` (INTERNAL, type `deploy`) per target Camp. Plus `cicd.pipeline.run.duration` / `.errors`. |
| `dora.ts` | DORA four keys and reconcile lag: the pure definitions plus the journal projection. |
| `fleet.ts` | `hobo.cd.fanout.camps{state}`, `hobo.cd.failover.count{state}`, `hobo.cd.compliance.noncompliant_ratio`, `hobo.cd.policy.shadow_divergence`, `hobo.cd.camp.condition`, `hobo.cd.camp.taint`. |
| `otlp.ts` | OTLP/HTTP JSON encoding (`ExportTraceServiceRequest`, `ExportMetricsServiceRequest`). |
| `sink.ts` | `createTelemetrySink`: OTLP/HTTP JSON exporter over `HttpTransport`. No SDK. |
| `telemetry.ts` | `createCdTelemetry`: `dora`, `reconcileLagMs`, `health`, `collect`, `export`. |
| `alerts.ts` | `CD_ALERT_RULES` and `CD_SLOS` (vendor-neutral data; WP21 documents them). |

## Architecture

- **Projection over the event store.** `createDoraProjection` is a
  materialized view: it reads `readAll({ tenant, after: cursor })`, so each
  refresh reads only new events. The cursor is the view's snapshot; the
  in-memory facts are its read store. It folds `freight.Recorded`,
  `env.Promoted`, `env.PromoteRolledBack`, `set.Created` and
  `deployment.Converged` events. Bodies are parsed with the generated
  protobuf schemas (`fromJson`, unknown fields ignored); a body that does not
  parse is skipped, never trusted (parse, don't validate: the derived
  `DoraFacts` type only exists after parsing).
- **Queries are commands-free.** Nothing here appends events; telemetry
  cannot change delivery.
- **Deterministic (I8).** Decisions use the injected `now`. Span ids are
  hashes of the promotion id; timestamps are recorded event times. A replay
  yields byte-identical spans.
- **Fleet metrics read the frozen ports** (`FanoutController.list`,
  `FailoverController.list`, `CampInventory.list`, `PostureService.compliance`,
  `CampPolicy.binding`, `PostureSeriesReader.shadowDivergence`), not other
  owners' stream bodies. Every builder emits a full gauge set (zeros
  included), so an emptied state is visible.

## DORA definitions

Window `(now − windowMs, now]`, optionally filtered by Camp.

- **Deployment**: an `env.Promoted` for a Bindle (Rail promotions excluded).
- **Deployment frequency**: deployments per day in the window.
- **Lead time** (p50): `env.Promoted` time − the Freight's `freight.Recorded`.
- **Change failure rate**: deployments followed on the same Camp, before
  its next deployment, by an `env.PromoteRolledBack`, ÷ deployments.
- **Time to restore** (p50): rollback time − failed deployment time.
- p50 is the nearest-rank median; empty samples are 0 (never NaN).

Reconcile lag: from the latest `set.Created` for a Camp to the first
`deployment.Converged` of that Set, or to `now` while pending.

## Exporter

- POST `<endpoint>/v1/traces` and `/v1/metrics`, `Content-Type:
  application/json`, default endpoint `http://localhost:4318`, timeout 10 s.
- Batches of ≤ 512 items per request.
- Retries 429/502/503/504 and transport errors: backoff 1 s × 2ⁿ capped at
  30 s, honouring `Retry-After` (capped), up to 5 attempts. No jitter.
- Non-retryable statuses fail at once. Partial success is surfaced.

### Failure modes (`TELEMETRY_FAILURES`)

| Code | Meaning | Remediation |
|---|---|---|
| `otlp-endpoint-invalid` | Endpoint not an absolute http(s) URL, or has a query/fragment/credentials. | Fix configuration; credentials go in `headers`. |
| `otlp-rejected` | Non-retryable status (400, 401, 403, 404, …). Batch dropped. | Check collector auth and the OTLP/HTTP JSON receiver. |
| `otlp-retries-exhausted` | Collector unavailable for every attempt. Batch dropped. | Check collector health and capacity. |
| `otlp-partial-success` | Collector rejected some items. | Read the collector's message (attribute limits, invalid values). |
| `telemetry-tenant-mismatch` | Query for another tenant. | Use that tenant's telemetry. |

Telemetry is advisory: every CD module swallows sink errors, so an outage
never fails a delivery command. `stats()` and `health()` make it visible.

## Metrics emitted

DORA gauges `hobo.cd.dora.{deployment_frequency, lead_time, change_failure_rate, time_to_restore}`
(window attribute `hobo.cd.dora.window`), `hobo.cd.reconcile.lag{hobo.camp.id}` (s),
fleet and policy gauges above, `hobo.cd.telemetry.export_failures`,
`cicd.pipeline.run.duration` and `cicd.pipeline.run.errors`.
Authorization metrics (`hobo.cd.authz.*`) are named here and emitted by
`@hobo/cd/authz`.

## Alert rules and SLOs

`CD_ALERT_RULES` (thresholds from `CD_DEFAULTS` and R12/R13):
`CdReconcileLagHigh`, `CdChangeFailureRateHigh`, `CdFanoutFailuresPresent`,
`CdFailoverInProgress`, `CdInformNoncompliantRatioHigh`, `CdShadowDivergence`,
`CdCampUnreachable`, `CdCredentialExpiring`, `CdAuthorizationUnrecorded`,
`CdTelemetryExportFailing`, `CdPipelineRunErrors`. `CD_SLOS`:
`reconcile-convergence` 99 %, `promotion-success` 95 %,
`authorization-recorded` 99.9 %, `telemetry-export` 99 %.

## Runbook

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
