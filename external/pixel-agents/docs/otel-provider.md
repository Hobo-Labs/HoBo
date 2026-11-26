# OpenTelemetry provider

The standalone server accepts **OTLP/JSON trace exports** and renders services as
office characters. This is pixel-agents' first push-based (non-hook) provider:
no hook scripts, no transcripts — spans themselves drive the characters.

## Endpoint

```
POST http://127.0.0.1:<port>/v1/traces
Content-Type: application/json
```

Accepts the OTLP/JSON traces subset: `resourceSpans[] → scopeSpans[] → spans[]`
with `traceId` / `spanId` / `name` / `kind` / `status` / `startTimeUnixNano` /
`endTimeUnixNano`, plus `resource.attributes`. Everything outside the subset is
ignored. A span record **without** `endTimeUnixNano` starts activity; a record
**with** it completes that span (match by `spanId`). No Bearer auth — same
policy as the standalone WebSocket endpoint (the server binds to 127.0.0.1).

Point any OTLP/HTTP-JSON exporter at it (e.g. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:3200/v1/traces`
with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`), or replay captured exports with curl.

## Mappings

Only two mappings exist; nothing else is inferred.

### Camp → Area

A span resource attribute **`hobo.camp`** names an office Area. On first sight
the server auto-materializes it in the saved layout as **one contiguous walled
room**:

- an `AreaDefinition` with a deterministic color (FNV-1a hash of the name → hue),
- a rectangular room enclosed by a 1-tile wall ring (`TileType.WALL`, walls
  unlabeled — same convention as the webview editor), with a single 2-tile
  door gap in the top wall facing the rest of the office (when the room is
  placed in a newly grown grid band, a corridor is punched through any wall —
  e.g. the old office border — directly above the door),
- inside, one workstation (desk + chair) per bindle in a deterministic
  3-cells-per-row grid (a 1–3 seat room is one cell row tall; three camps fit
  under MAX_ROWS=64 with the default office),
- interior floor tiles painted with the camp's label; chair seats always land
  on labeled floor inside the room, so the webview's stage-1 seat preference
  works unchanged.

Allocation is first-fit over free floor for a room-sized rectangle plus a
1-tile floor margin on every side (two rooms always keep ≥1 tile of
separation); when nothing fits, the grid grows downward/right, bounded by
MAX_COLS/MAX_ROWS=64 like the editor's `expandLayout`. Existing user
furniture/areas are never touched. Growing within a room's spare capacity
fills empty cells in place; when a room is full it is **relocated** — the
intact room (including its wall ring) is wiped and a fresh, larger single
room is allocated — so a camp never splits into two regions. Workstation uids
(`otel-<camp>-ws<n>-*`) are stable across relocation, so seated characters
keep their seat assignments through the webview's layout rebuild. Changes are
written to `~/.pixel-agents/layout.json` and broadcast as `layoutLoaded`.

The first time a camp is materialized, the provider also persists
`pixel-agents.showAreas: true` (standalone settings) so camp zones render
tinted.

**Migration.** On provider boot (`validatePersistedAreas`, wired in `cli.ts`)
and on first span for a camp, every camp listed in `areaMappings` is checked
with `analyzeCampRoom`: a camp whose labels form more than one 4-connected
component is **fragmented**; one whose labeled floor touches more than a
door-width of unlabeled floor is **unenclosed**. Broken rooms are wiped
(labels + OTel furniture) and re-allocated as one enclosed room with the same
seat count. The wipe only happens when the camp has OTel-placed furniture
(the `otel-<slug>-ws*` uid marker) — hand-painted user areas without that
marker are left untouched even when they look "invalid". Wall tiles from
broken rooms are kept (they can't be told apart from user walls); walls of
intact rooms are reverted to floor on relocation because their ring geometry
is exactly known.

### Bindle → Character

**`hobo.bindle`** (falling back to the standard **`service.name`**) is the
agent identity: one character per bindle, created on its first span. While the
bindle has active spans the character animates:

| Span shape                                   | Character state                       |
| -------------------------------------------- | ------------------------------------- |
| kind server/client/internal                  | typing ("Running: \<span name\>")      |
| kind producer/consumer, or `db.*`/`messaging.*` attrs | reading ("Reading \<span name\>") |
| `status.code = 2` (error)                    | attention bubble (permission state)   |
| last active span ends                        | idle / waiting                        |

When a bindle belongs to a camp, the character's `folderName` is the camp name
and `areaMappings[folderName]` points at the camp's Area, so the webview's
existing stage-1 seat preference places it inside the camp's Area.

## Demo

```bash
node dist/cli.js --port 3200          # build first: node esbuild.js
node scripts/otel-demo.mjs --port 3200
```

The demo simulates 3 camps × 3 bindles with a start/stop cadence (mixed span
kinds, db/messaging spans, occasional error spans). Flags: `--ticks`,
`--interval-ms`.

## Design notes / deliberate seams

- **Not a `HookProvider`.** `AgentRuntime` is constructed around exactly one
  hook provider (Claude) with a session router and JSONL scanners that don't
  apply to spans. `OtelProvider` (`server/src/providers/otel/`) therefore
  translates spans into the canonical `AgentEvent` model and applies them
  directly to the `AgentStateStore`, emitting the same broadcast messages the
  hook path emits (`agentToolStart` / `agentToolDone` / `agentToolsClear` /
  `agentStatus` / `agentToolPermission`). No changes to Claude behavior.
- **Animation selection reuses the status-prefix convention**: the webview maps
  status text ("Reading …" / "Running: …") onto tool names, so no webview
  changes were needed.
- **Characters persist across restarts** via empty per-bindle placeholder
  transcripts under `~/.pixel-agents/otel/` (the restore/stale-check machinery
  keys on transcript files).
- **Standalone only**: the route is registered when the host wires
  `onOtelTraces`; the VS Code adapter doesn't.
- **Late camp attribution** (first span lacks `hobo.camp`) updates the mapping
  but does not reseat an already-seated character — the webview's layout
  rebuild preserves existing seat assignments.

Tests: `server/__tests__/otelSpan.test.ts`, `otelAreaPlanner.test.ts`,
`otelProvider.test.ts`.
