# @hobo/yard-world

The pure yard-world model for HoBo observability: OpenTelemetry spans, logs,
and metrics mapped onto HoBo primitives rendered as an animated tile world.
Zero runtime dependencies; no I/O in the core.

**Provenance:** promoted from the draft proof
[`@hobo-draft/otel-office`](../../src/draft/projects/otel-office/) (the
pixel-office observability POC). The draft's server (`server.ts`) and browser
client were deliberately **not** promoted — serving is owned by the hosting
service (control-api). The draft remains in place as reference; see its
`ADR.md` for the design history.

| HoBo primitive | World element | Signal → behavior |
|---|---|---|
| Bindle | Character at a desk | server/client/internal span → working; db/messaging span → reading; no spans → idle; error/long-blocking span → stuck |
| Camp | Camp room (tile rect) | bindles of the camp sit inside |
| Yard | Floor/zone | groups camp rooms |
| Junction | Corridor | cross-camp trace pair → packet walks the corridor for the span's duration |
| Station | Building (hard isolation, ADR-0131) | entities never mix across stations |
| Crew / actor | Extra characters | `hobo.primitive=crew\|actor` resource attribute |
| Metric | Health bar | `hobo.health` gauge / `hobo.error.rate` sum → `metric-sample` (see `METRIC_HEALTH_MAP`) |
| Log (WARN+) | Speech bubble | expires after `BUBBLE_TTL_MS`; ERROR also flips the character to stuck |

## Modules

- [`src/model.ts`](./src/model.ts) — typed `AgentEvent` union, pure reducer
  (`applyEvent`), character state machine (idle/working/reading/stuck),
  `ActivityLog` ring buffer, `WorldState`.
- [`src/otel-mapper.ts`](./src/otel-mapper.ts) — OTLP/JSON → model mappers:
  `mapTracePayload`, `mapLogsPayload`, `mapMetricsPayload`; `hobo.*` resource
  attributes pin topology, unknown services auto-materialize.
- [`src/trace-index.ts`](./src/trace-index.ts) — bounded (10k entries / 15 min
  TTL) span index so cross-camp trace pairs resolve across separate OTLP
  requests.
- [`src/layout-model.ts`](./src/layout-model.ts) — layout-as-data
  (`WorldLayout`): derive/sync/apply plus full structural + semantic
  `validateLayout` and BFS `findPath`. Pure.
- [`src/layout-store.ts`](./src/layout-store.ts) — **node-only** JSON
  persistence for layouts (`YARD_WORLD_HOME`, default `~/.hobo-yard-world/`);
  excluded from `src/index.ts`, import via `@hobo/yard-world/layout-store`.
- [`src/cd-views.ts`](./src/cd-views.ts) — HoBo CD views (plan 0024 WP19):
  `parseCdSpans` (parse boundary for OTel CI/CD spans), `freightTimeline`,
  `pipelineGraph`, `renderPromotionTrace`, and the fleet views `fleetView`
  (Camps by condition and taint) and `complianceHeatmap` (noncompliance by
  Rail × control). See [HoBo CD](#hobo-cd) below.
- [`src/simulator.ts`](./src/simulator.ts) — deterministic (mulberry32-seeded)
  platform simulator that routes OTLP payloads through the same mappers and
  trace index; same seed → identical event stream.

## HoBo CD

`@hobo/cd` exports promotions as OTel CI/CD spans (`RUN <pipeline>` pipeline
runs, `promote <camp>` task runs) that carry topology as **span** attributes
(`hobo.camp.id`, `hobo.station.id`, `hobo.yard.id`, `hobo.freight.id`,
`hobo.cd.pipeline.node`, `deployment.environment.name`), because one CD
service delivers to many Camps.

- `mapTracePayload` first runs `liftCdTopology`: spans naming a Camp move to a
  per-Camp resource, so each delivery task lands in its Camp room as an
  `actor` character `<service>@<camp>` in the right Station. A resource that
  already pins `hobo.camp` is left alone; spans without `hobo.camp.id` are
  unchanged.
- `freightTimeline` (Freight → deliveries in time order, result per Camp)
  and `pipelineGraph` (nodes with last Freight/result, edges a Freight
  travelled) are projections over parsed CD spans.
- `fleetView` reads the `hobo.cd.camp.condition` / `hobo.cd.camp.taint`
  gauges; `complianceHeatmap` reads `hobo.cd.compliance.noncompliant_ratio`
  (latest point per Rail × control × mode; bands: `ok` = 0, `watch` ≤ 2 %,
  `breach` > 2 %, the R12 INFORM budget).
- Wire forms: the `*Record` messages at the end of
  `data-models/yard_world.proto` with CUE constraints in
  `data-models/yard_world.cue`.

The CD attribute keys are mirrored from `@hobo/cd/telemetry` (`semconv.ts`),
not imported, because this package has no dependencies. Golden trace:
`test/cd-promotion-trace.otlp.json`, produced by `@hobo/cd`'s span builder and
OTLP encoder.

### Runbook

- **Delivery characters pile up in the `default` Camp.** The CD spans lack
  `hobo.camp.id` (multi-Camp pipeline-run spans legitimately stay with the
  CD service). Task spans always carry it; if they do not, check the
  `@hobo/cd` version and its `CampLocator` composition.
- **A Camp shows in the wrong Station.** The span's `hobo.station.id` comes
  from the CD topology port; fix the Camp's declared Station there. Stations
  never mix (ADR-0131), so a wrong id creates a separate building.
- **Heatmap cell stuck on an old value.** Cells keep the latest point per
  Rail × control × mode; a Rail no longer evaluated keeps its last cell until
  the hosting service restarts its read model.
- **Golden trace drift.** If `@hobo/cd` span shapes change, regenerate
  `test/cd-promotion-trace.otlp.json` from `promotionSpans` + `encodeTraces`
  and review the timeline/graph expectations in `test/cd-views.test.ts`.

## Types

Records, messages, data, and objects are protobuf in
[`data-models/yard_world.proto`](./data-models/yard_world.proto) with a CUE
constraint per type in [`data-models/yard_world.cue`](./data-models/yard_world.cue).
The TypeScript surface follows **parse, don't validate**: the OTLP mappers are
the single parse boundary where raw OTLP/JSON becomes parsed, derived domain
types (the `AgentEvent` union and `PrimitiveRef`-derived character identity);
the reducer and any consumer only ever see those derived types, never raw
DTOs. Generated `*_pb.ts` codegen from the proto is a tracked gap inherited
from the draft.

## Event architecture

Commands are the OTLP ingests a hosting service accepts (`POST
/v1/traces|logs|metrics`); events are the `AgentEvent` union (`span-started`,
`span-ended`, `packet-started`, `metric-sample`, `log-record`, `tick`); the
reducer plus `TraceIndex` act as the actor layer (one state machine per
character actor); the host's event log is the event store; `WorldState` and
the per-character `ActivityLog` ring buffer are the materialized views /
projections; a persisted `WorldLayout` (via the node-only layout store) is the
snapshot store; renderers and inspect panels are the read store consumers.

## Boundary

`@hobo/yard-world` has **zero runtime dependencies** and depends on no other
`@hobo/*` package. PACT evidence in [`contracts/`](./contracts) pins the
serving boundary the hosting service (control-api) must provide.

## Validation

```sh
pnpm --filter @hobo/yard-world test        # vitest: reducer, mappers, index, simulator
pnpm --filter @hobo/yard-world typecheck
```
