# `@hobo/cd/service` — service host and read API (WP12: C13)

Two pieces, both built only on the frozen ports in `../ports.ts`:

- **`createCdService`** implements the frozen `CdService` (`start`, `ready`,
  `drain`) plus `tick()` and `health()`. It is the long-running host behind
  `hobo serve cd` (composed by WP18), modelled on the CI relay host.
- **`createCdControlApi`** is the `/v1/cd/` HTTP surface that
  `@hobo/control-api` mounts (`createControlApiServer({ cd })`). It answers the
  read routes and the SSE stream itself and hands every other `/v1/cd/` path
  (enrollment, leases, feed, blobs, observations, checkpoints) to the delivery
  feed (`../feed`) unchanged, so one mount serves operators and agents.

```ts
import { createCdControlApi, createCdService } from "@hobo/cd/service";

const service = createCdService({ store, tenant, now, cd, reconcilers, retention,
  tickIntervalMs: CD_DEFAULTS.serviceTickMs, principal, telemetry });
await service.start();
const control = await createControlApiServer({
  hoboHome, cd: createCdControlApi({ store, tenant, now, cd, topology, service, telemetry }),
});
// on SIGTERM:
await service.drain(AbortSignal.timeout(25_000));
```

## Architecture

- **Commands and events.** The host issues no commands of its own; it calls
  each module's tick, and the modules (actors over their journal streams)
  append the events in `CD_EVENTS`. The read API never appends.
- **Event store.** One `DurableEventStore` (SQLite single-node, Postgres
  multi-node). Readiness probes it; the SSE stream tails it by position with
  `readAll`.
- **Projections and read store.** Every read route is a pure fold over the
  modules' projections (`DesiredStateReader`, `CampInventory`,
  `FanoutController.get`, …), which are the materialized views and the read
  store; the API keeps no state, so any replica serves any request. No
  snapshot is cached here — module snapshots stay inside the modules.
- **Parse, don't validate.** `parseReadRequest` turns a raw request into a
  `CdReadRoute` of parsed, derived types (`PathName`, `CampId`, `Digest`,
  `EventPosition`, `ConditionFilter`, `TaintFilter`, `FailoverState`) once;
  nothing past `routes.ts` re-checks a string.

## Tick loop

One tick every `tickIntervalMs` (default `CD_DEFAULTS.serviceTickMs`, 1 s),
never overlapping, in this order (`CD_SERVICE_STEPS`):

| # | Step | Port call |
|---|---|---|
| 1 | `sources` | `FreightSources.tick` (scheduled polls, webhook nudges) |
| 2 | `inventory` | `CampInventory.tick` (lease/credential/claims conditions, automatic `NO_PLACE`) |
| 3 | `pipelines` | `PipelineController.tick` (availability, auto-promotion) |
| 4 | `promotions` | `PromotionService.tick` (in-flight sagas) |
| 5 | `verification` | `VerificationEngine.tick` |
| 6 | `rollouts` | `RolloutOrchestrator.tick` |
| 7 | `fanout` | `FanoutController.tick` (under `cd:fanout:<id>`) |
| 8 | `failover` | `FailoverController.tick` |
| 9 | `posture` | `PostureService.tick` |
| 10 | `previews` | `PreviewEnvironments.expirePreviews` |
| 11 | `retention` | `FreightLedger.retire(policy)` per `RetentionPolicyRecord`, at most once per `retentionIntervalMs` (default 1 h) |

The host makes no delivery decision: every step is the module's own "safe to
repeat" tick, so a crash anywhere resumes by observation. Each tick first
probes the journal (`readAll({limit: 1})`); when the probe fails no module step
runs. A step that throws is isolated (the rest of the tick still runs) and is
reported in `health()`; a step still running after `stepTimeoutMs` (default
30 × tick, at least 30 s) is reported failed and skipped on later ticks until
it settles, so ticks never stack.

Reconcilers (`CampReconciler.run(signal)`) are supervised: a run loop that
exits or throws before drain is restarted with backoff (1 s doubling to the
30 s lease TTL; reset after a run that lasted at least that long).

## Readiness

`ready()` is true only when the service is started and not draining, the
journal probe passed, every reconciler run loop is alive (each holds its
per-Camp `cd:camp:<id>` leases), and the last `sources` step succeeded.
`health()` returns one check per dependency and step (`store`,
`reconciler:<id>`, `step:<name>`, `drain`). `GET /v1/cd/ready` serves it: 200
with the report, or 503 with one `not-ready` reason per failing check.

## Drain

`drain(signal)` stops the loop, aborts the reconcilers' signal (each releases
its leases and returns), and waits for the in-flight tick and every run loop —
or until `signal` aborts, whichever is first. It always returns by the
deadline; what was still pending is reported as `drain-deadline-exceeded` in
`health()` and those leases expire after their TTL.

## Read API (`/v1/cd/`, GET only)

| Path | Value |
|---|---|
| `/v1/cd/pipelines/{name}` | graph: per node `edges`, `camps` (current Freight + Set per Camp), `available` Freight, and for placed nodes `placement`, `decisionId`, `qualified` |
| `/v1/cd/freight/{id}` | Freight (id or alias) with a timeline across Camps: `recorded`, `promotion`, `qualified`, `approved`, `yanked`, `retired` |
| `/v1/cd/promotions?camp=&limit=` | promotions (limit 1–1000, default 100) |
| `/v1/cd/camps?set=&taint=&condition=` | inventory; `taint` = `NO_PLACE`/`NO_RUN`/key; `condition` = `READY`, `READY=false`, … |
| `/v1/cd/camps/{id}/status` | current Set, last reconcile observation, inventory status |
| `/v1/cd/camps/{id}/inventory` | declared topology and observed status |
| `/v1/cd/placements/{name}/decisions/{id}` | a recorded placement decision |
| `/v1/cd/fanouts/{id}` | fan-out status |
| `/v1/cd/failovers?state=` | failovers, most recent first |
| `/v1/cd/compliance?camp=&rail=` | compliance records (all Camps when `camp` is omitted) |
| `/v1/cd/ready` | readiness report |
| `/v1/cd/openapi.json` | OpenAPI 3.1 of these routes (merged into `/v1/openapi.json`) |
| `/v1/cd/stream` | SSE of every `cd-*` journal fact |

Records are canonical protobuf JSON of `hobo.cd.v1` (camelCase, enum names,
64-bit integers as strings) in the feed's envelope, `{ok: true, value}` or
`{ok: false, reasons: [ReasonRecord]}`. Queries are parsed once into
`CdReadRoute` (`routes.ts`); bad input is `query-invalid` naming the parameter.

**Stream.** `id: <journal position>`, `event: <event type>`, `data:
{position, streamId, type, ts, data}`. Resume with `Last-Event-ID` (or
`?after=`; the header wins): frames start strictly after it, so nothing is
skipped or repeated. `?types=` filters by event type. A heartbeat comment
every 15 s; the response ends with `event: end` after the 55 s long-poll bound
and EventSource reconnects with the last id. Inventory, placement, fan-out,
failover, policy and compliance facts are all journal events, so everything
the read routes show is also on the stream. A journal failure ends the stream
with `event: error` (`store-unavailable`).

**Contract.** `packages/control-api/contracts/pacts/control-api-cd.pact.json`
(consumer `@hobo/hobo`, provider `@hobo/control-api`), verified in
`test/service/pact.test.ts` against the real handler; every response is also
validated against the schema the OpenAPI document declares for its path and
status. Envelope and view shapes are constrained in
`packages/control-api/data-models/control_api.{proto,cue}` (`Cd*`).

## Typed failures (`SERVICE_FAILURES`)

| Code | HTTP | Meaning |
|---|---|---|
| `route-unknown` | 404 | not a read route (feed paths fall through first) |
| `method-not-allowed` | 405 | read routes are GET only (`allow: GET`) |
| `not-found` | 404 | id or name unknown |
| `query-invalid` | 400 | bad query/path parameter; `subject` names it |
| `last-event-id-invalid` | 400 | not a decimal 64-bit position |
| `store-unavailable` | 503 | the journal failed |
| `view-failed` | 500 | a module projection threw |
| `not-ready` | 503 | readiness check failing |
| `step-failed` | — | a tick step threw or timed out (health) |
| `reconciler-crashed` | — | a reconciler run loop exited (health) |
| `drain-deadline-exceeded` | — | drain returned at its deadline (health) |
| `already-started` | — | `start()` called twice (`CdServiceError`) |

## Telemetry (through `TelemetrySink`)

Service: `hobo.cd.service.tick_ms`, `hobo.cd.service.step_ms` (`step`,
`outcome`), `hobo.cd.service.step_failures` (`step`),
`hobo.cd.service.ready` and `hobo.cd.service.store_up` (gauges, 0/1),
`hobo.cd.service.reconciler_restarts` (`reconciler`),
`hobo.cd.service.retention_retired`, `hobo.cd.service.drain_ms`
(`completed`). Read API: `hobo.cd.api.requests` (`route` = first path segment,
`status`), `hobo.cd.api.request_ms`, `hobo.cd.api.stream_frames`. Emission is
best-effort; a broken exporter never affects the loop.

## Runbook

- **`/v1/cd/ready` is 503 with `store`.** The journal probe failed; no module
  step runs until it recovers, and readiness returns by itself on the next
  successful probe. Check the SQLite file / Postgres connectivity (pool,
  statement timeout). Agents keep their leases until TTL and resume by
  observation.
- **503 with `reconciler:<id>` / `reconciler-crashed`.** A run loop exited; the
  host restarts it with backoff (≤ 30 s). If it keeps crashing, read the detail
  (lease refusal, store error, realizer error) and follow the reconcile
  runbook. `hobo.cd.service.reconciler_restarts` climbs while this happens.
- **503 with `step:sources`.** Discovery failed (registry/Git host
  unreachable or credentials wrong). Promotions of existing Freight still run;
  new Freight waits. See the sources runbook.
- **`step:<other>` failing but ready.** Only store, leases and sources gate
  readiness; other steps retry every tick. A step reported as exceeding its
  deadline is skipped until its earlier call settles — look for a hung
  provider call in that module.
- **Drain reports `drain-deadline-exceeded`.** A reconciler or the in-flight
  tick did not stop in time; the process can exit anyway. Its leases expire
  after 30 s and another holder resumes by observation (no double writes: the
  fence refuses the old holder).
- **Retention never runs.** It runs on the first tick and then at most once per
  `retentionIntervalMs` (1 h); check `step:retention` and
  `hobo.cd.service.retention_retired`.
- **SSE clients see repeated or missing facts.** They must resume with the last
  `id:` they received as `Last-Event-ID`; `event: end` after 55 s is expected.
  A malformed id is refused with `last-event-id-invalid`.
- **A read route returns `view-failed`.** A module projection threw; the
  `subject` names the route. Check that module's runbook; the service log has
  the stack.
