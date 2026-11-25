# `@hobo/control-yard` architecture

```
Projection snapshot  →  entity-state (visual FSM)
                     →  yard-engine (Bo motion, particles, cost meter)
                     →  OpenUI sheets (schema-derived)
                     →  Phaser load manifest (asset index only)
```

## Schema and constraints

- Protobuf records live in [`data-models/control_yard.proto`](./data-models/control_yard.proto).
- CUE constraints in [`data-models/control_yard.cue`](./data-models/control_yard.cue) bound every protobuf message.
- PACT consumer evidence under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

`deriveYardVisualState` is the **parse, don't validate** boundary for the game:
a `YardProjectionSnapshot` (already folded) becomes frozen **derived types**
(`YardVisualState`, zone visual enums, cost meter fill/heat). Scene code never
re-checks occupancy/rail/connection primitives.

Asset load uses **measured** `assets_index.json` only — frame sizes are not guessed.

## Event architecture

- **Command** — zone click → generative sheet confirm → management command (via control-api).
- **Events** — consumed only through projections; yard never appends Station/Connection events itself.
- **Actor** — `YardEngine` is the single visual actor driven by projection ticks.
- **Event store** — upstream `HOBO_HOME` via control-api/management (not local to the yard).
- **Materialized view / projection** — control-api yard snapshot/SSE is the projection feed.
- **Snapshot** — last applied `YardVisualState` + particle pool in engine memory.
- **Read store** — Phaser registry / engine fields (no global `window` game state).

No hard-coded clip names. Bo west sheet is never a mirror.
