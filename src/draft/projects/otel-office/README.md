# OTel Office — HoBo platform observability as a pixel office

Draft POC (Phase 2, slice 1: playable/inspectable). HoBo primitives rendered as
an animated office driven by OpenTelemetry signals — a clean-room, OTel-geared
take on the pixel-agents office concept.

| HoBo primitive | Office element | Signal → behavior |
|---|---|---|
| Bindle | NPC at a desk | server/client/internal span → working (green); db/messaging span → reading (blue); no spans → idle (gray); error/long-blocking span → stuck (red) + pulsing flag |
| Camp | Office room (tile rect) | bindles of the camp sit inside |
| Yard | Floor/zone | groups camp rooms |
| Junction | Corridor | cross-camp trace pair → packet sprite walks the corridor for the span's duration |
| Station | Building switcher + name banner | entities never mix across stations (ADR-0131) |
| Crew / actor | Extra characters | `hobo.primitive=crew|actor` resource attribute |
| Metric | Health bar | `hobo.health` gauge / `hobo.error.rate` sum → `metric-sample` (see mapping table below) |
| Log (WARN+) | Speech bubble | auto-expires after 8s; click it to inspect the character; ERROR also flips the character to stuck |

## Install / Configure / Run

```sh
pnpm install                                   # repo root, once
pnpm --filter @hobo-draft/otel-office build    # compile server + browser client
pnpm --filter @hobo-draft/otel-office start    # the single command to run the app
```

Then open the printed URL (default: OS-assigned free port). Knobs:

- `--port=8080` or `PORT=8080` — pin the port.
- `OTEL_OFFICE_SIM=0` — disable the built-in platform simulator (office then
  only reacts to real OTLP posted to `/v1/traces`).

Controls: drag or arrow keys to pan, mouse wheel to zoom (clamped), click a
character (or its speech bubble) to open the inspect panel, click empty floor
to close it. Sound (stuck-transition beep) is muted by default — toggle in the
header. The render loop is decoupled from SSE ticks: characters and packets
interpolate smoothly between tile positions.

Endpoints: `GET /` (client), `GET /state` (JSON snapshot), `GET /events` (SSE),
`GET /character/<id>/activity` (bounded per-character ring buffer: last 50
spans with trace/span id, name, kind, duration, status, plus recent logs and
metric samples), `POST /v1/traces` (OTLP/JSON trace ingest),
`POST /v1/logs` (OTLP/JSON logs ingest), `POST /v1/metrics` (OTLP/JSON metrics
ingest, `sum` + `gauge` data points via `asDouble`/`asInt`).

A server-side **trace index** (bounded: 10k spans / 15 min TTL) records every
ingested span, so cross-camp junction packets are derived even when the parent
and child spans arrive in **separate** OTLP requests — the normal collector
fan-out. Send sample signals against a running server:

- `examples/post-trace.sh [port]` — single-service trace;
  `examples/sample-cross-camp-trace.json` is a client→server cross-camp pair in
  one request.
- `examples/post-cross-request.sh [port]` — the same pair posted as **two**
  requests (parent, then child) and prints the resulting packet from `/state`.
- `examples/post-logs.sh [port]` — INFO/WARN/ERROR records (WARN+ → speech
  bubble, ERROR → stuck attention).
- `examples/post-metrics.sh [port]` — health gauge + error-rate sum + an
  unknown metric (activity-log only).

### Metric → health-bar mapping

Explicit table (`METRIC_HEALTH_MAP` in `src/otel-signals.ts`); values clamp to
0..1. Anything not listed lands in the character's activity log under its own
name and shows up in the inspect panel's Metrics section.

| Metric name | Data | Health value |
|---|---|---|
| `hobo.health` | gauge 0..1 | `value` |
| `hobo.error.rate` | gauge/sum 0..1 | `1 - value` |

### Inspect panel

Click a character (or its bubble): the panel groups recent spans into
**journeys** — one per traceId, spans in start order with relative timing bars
— plus Logs (severity-colored, trace-linked when the record carries a traceId)
and Metrics sections.

## Validation

- `pnpm --filter @hobo-draft/otel-office test` — 60 tests: reducer transitions
  (incl. packet lifecycle), activity ring-buffer retention, OTLP mapper
  (kind/status → state, station isolation, in-request + cross-request trace-pair
  derivation), trace-index bounds (TTL + max-size eviction), OTLP logs/metrics
  mappers (severity ranges, health mapping, unknown-metric passthrough),
  simulator determinism, HTTP smoke (incl. activity endpoint, logs/metrics
  intake, cross-request packet over HTTP).
- `pnpm --filter @hobo-draft/otel-office typecheck`

## Maintenance note

Phase 2 slice 1 (2026-07): fixed-timestep-friendly render loop with
interpolation, camera pan/zoom, click-to-inspect observability panel backed by
a per-character activity ring buffer, junction trace packets, stuck attention
states (pulsing flag + optional beep), explicit station isolation banner.

Phase 2 slice 2 (2026-07): telemetry depth — server-side trace index (10k
spans / 15 min TTL) derives cross-camp packets across separate OTLP requests;
`POST /v1/logs` and `POST /v1/metrics` OTLP/JSON intakes (WARN+ bubbles, ERROR
→ stuck, explicit metric→health mapping table, unknown metrics in the activity
log); inspect panel groups spans into per-traceId journeys with timing bars
plus Logs/Metrics sections; simulator routes through the same mappers + index
(parent/child spans emitted on different ticks) and emits gauge metrics and
varied-severity logs, all seeded-deterministic.
Tracked gaps (protobuf event model, PACT runner, cucumber features, bench) are
listed in `ADR.md`; waivers are declared in `proof.json`.
