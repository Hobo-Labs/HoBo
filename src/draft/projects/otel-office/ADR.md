# ADR: OTel Office — pixel-office observability POC

> **Promoted:** the engine (model, OTLP mappers, trace index, layout,
> simulator) was promoted to [`packages/yard-world`](../../../../packages/yard-world/)
> (`@hobo/yard-world`) with office→world vocabulary renames
> (`OfficeState`→`WorldState`, `OfficeLayout`→`WorldLayout`). The server and
> browser client were not promoted — serving is owned by control-api. This
> draft remains as reference.

## Status
Proposed (draft POC, Phase 2 slice 2)

## Context
Operators watching a HoBo platform read raw OTel streams (traces, metrics, logs)
with no spatial intuition for topology. The pixel-agents project
(https://github.com/pixel-agents-hq/pixel-agents) showed an office metaphor where
animated characters make agent activity legible at a glance. This proof recreates
the concept clean-room, geared toward OpenTelemetry observability of HoBo
primitives: Bindle → NPC at a desk, Camp → office room, Yard → floor/zone,
Junction → corridor, Station → building switcher (hard isolation, ADR-0131),
crew/actors → extra characters.

## Decision
- Zero runtime dependencies: `node:http` + Server-Sent Events; browser client is
  TypeScript compiled by the package's own `tsc` build and served as static files.
- Single normalized event model (`src/model.ts`): span-started / span-ended /
  packet-started / metric-sample / log-record / tick, consumed by one pure
  reducer. Character state machine: idle / working / reading / stuck, driven by
  span kind (server|client|internal → working; db/messaging → reading), error
  status or long-blocking spans → stuck, WARN+ logs → speech bubbles, metrics →
  health bar.
- OTLP/JSON ingest (`src/otel.ts`): subset of ExportTraceServiceRequest;
  `hobo.station` / `hobo.yard` / `hobo.camp` / `hobo.junction` / `hobo.primitive`
  resource attributes pin topology; unknown services auto-materialize.
  Station-scoped character ids enforce ADR-0131 isolation (never mix in one view).
- Deterministic simulator (`src/simulator.ts`, mulberry32 seeded RNG): 1 station,
  2 yards, 4 camps + ops camp, 12 characters, 3 junctions; same seed → same
  event stream, so the office is alive with no collector attached.
- Cross-camp spans walk the junction corridor tile path, one tile per tick.
- **Trace journeys (Phase 2)**: the mapper pairs a client/producer span in camp A
  with its server/consumer child span in camp B (same traceId, via
  `parentSpanId`) — or honors a `hobo.junction` span attribute — and emits
  `packet-started`. The reducer walks the packet sprite along the junction
  corridor one tile per tick; the packet despawn on span end, path exhaustion,
  or span-duration elapsed.
- **Inspectability (Phase 2)**: the server feeds the same event stream into an
  `ActivityLog` — a bounded per-character ring buffer (last 50 spans / logs /
  metric samples, `ACTIVITY_LIMIT`) — exposed as
  `GET /character/<id>/activity`. The client's click-to-inspect panel renders
  it; clicking empty floor closes the panel.
- **Client loop (Phase 2)**: rAF render loop decoupled from SSE ticks;
  characters and packets lerp toward their latest tile target (snap when >4
  tiles away, so station switches never smear). Camera pans via drag/arrow keys
  and zooms via wheel (clamped 0.5–3×, cursor-anchored), `imageSmoothing`
  disabled for pixel crispness.
- **Attention states (Phase 2)**: stuck characters get a pulsing flag; their
  speech bubble shows the latest WARN/ERROR log and is clickable into the
  inspect panel. A WebAudio beep on stuck transitions ships muted by default
  behind a header toggle.
- **Station switcher (Phase 2)**: stations remain separate buildings; the
  canvas draws an explicit `station: <name>` banner and only ever renders the
  active station's entities.
- **Server-side trace index (Phase 2 slice 2)**: `src/trace-index.ts` holds a
  bounded in-memory index of recently ingested spans keyed by
  `${traceId}:${spanId}`. Every span posted to `/v1/traces` is recorded; the
  mapper resolves a child's `parentSpanId` against it when the parent is not in
  the same payload, so cross-camp packet pairs survive the normal collector
  fan-out (each service exports separately). Bounds: **10,000 entries max**
  (oldest-first trim, re-recording refreshes recency) and a **15-minute TTL**,
  both enforced lazily on record/lookup — memory stays flat under continuous
  ingest and stale parents simply resolve to no-packet.
- **OTLP logs intake (Phase 2 slice 2)**: `POST /v1/logs` maps
  ExportLogsServiceRequest (`severityNumber` ranges 13–16 WARN / 17+ ERROR,
  with `severityText` fallback) onto `log-record` events. WARN+ raises the
  speech bubble; ERROR additionally flips the character to the stuck attention
  state. Records carrying a `traceId` keep it in the activity log for the
  inspect panel.
- **OTLP metrics intake (Phase 2 slice 2)**: `POST /v1/metrics` maps `sum` and
  `gauge` data points (`asDouble`/`asInt`). An explicit mapping table
  (`METRIC_HEALTH_MAP`) drives the health bar: `hobo.health` gauge 0..1
  directly, `hobo.error.rate` as `1 - rate`; unknown metric names bypass the
  bar and land in the ActivityLog only.
- **Simulator realism (Phase 2 slice 2)**: the simulator emits OTLP/JSON
  payloads routed through the same mappers and the same TraceIndex as the HTTP
  ingest; cross-camp parent and child spans are emitted on different ticks so
  junction packets exercise the cross-request pairing path. Gauge health
  metrics and varied-severity logs (INFO/WARN/ERROR, deterministic) are
  emitted per tick. Determinism is unchanged: mulberry32 RNG + tick clock, no
  wall clock.

## Architecture evidence

- **Contracts**: `data-models/otel_office.proto` defines the boundary records
  (`SpanRecord`, `LogRecord`, `MetricSample`, `PrimitiveRef`,
  `CharacterState`); `data-models/otel_office.cue` constrains every one of
  them (id formats, kind/status ranges, health metric 0..1, primitive enum).
- **Parse, don't validate**: the OTLP endpoints in `src/server.ts` are the
  single parse boundary — raw OTLP/JSON becomes parsed domain types
  (`AgentEvent` union members and `PrimitiveRef`-derived character identity)
  inside `src/otel.ts` / `src/otel-signals.ts`; the reducer in
  `src/model.ts` and the client only ever see those derived types, never raw
  DTOs, so invalid spans are unrepresentable past the boundary.
- **Event architecture**: commands are the OTLP ingests
  (`POST /v1/traces|logs|metrics`); events are the `AgentEvent` union
  (`span-started`, `span-ended`, `metric-sample`, `log-record`,
  `packet-started`, `tick`); the reducer + `TraceIndex` act as the actor
  layer (one state machine per character actor); the in-memory `OfficeState`
  plus the per-character `ActivityLog` ring buffer is the event store; SSE
  snapshots and `/state` are the materialized view / projection; the layout
  persistence under `OTEL_OFFICE_HOME` is the snapshot store; the browser
  client is the read store consumer.

## Consequences / tracked gaps
- **Codegen gap**: proto + CUE contracts exist under `data-models/`, but the
  runtime still uses plain TS types; generated `_generated/**_pb.ts` types
  imported by the reducers are later-phase work.
- **PACT gap**: a consumer-boundary fixture exists under `contracts/` but is not
  yet executed by a PACT runner; HTTP smoke tests pin the boundary meanwhile.
- **Bench waived**: fixed small office, no hot path to measure yet (waiver above).
- **Features waived**: cucumber behavior specs land with the interaction phase.
- Client renders programmatic pixel shapes only; no sprite assets by design.
- The trace index is per-process memory: a server restart loses cross-request
  pairing for in-flight traces (acceptable for the POC; a durable span store is
  later-phase work).
