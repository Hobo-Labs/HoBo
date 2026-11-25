# HOBO-608 trigger attachment + local dispatch — Architecture Evidence

## Schema and constraints

- Protobuf data shapes live in [`data-models/`](./data-models/).
- CUE constraints bound every protobuf type (`DurableRuntimeLink`, `TriggerEdge`, `TriggerFiredEvent`).
- PACT contracts under [`architecture/pacts/`](./architecture/pacts/) record bindles→collector and dispatcher→ports boundaries.

## Parse, don't validate

Untrusted attachment inputs cross one parser boundary (`createHandle`, `registerHostTrigger`, `compileHandlerManifest`) into **derived domain types** (`TriggerEdge`, parsed manifest records). Downstream `TriggerDispatcher` consumers receive those parsed, derived types instead of re-checking raw DTOs. CUE constraints bound the same derived types so malformed trigger rows are rejected at parse time.

## Event architecture

`TriggerDispatcher` emits `trigger.Fired` facts to an injectable **event store**; it never mutates **read models** directly.

- **Command** — wire a manifest trigger edge to a runtime-local port handler.
- **Event** — `trigger.Fired` (and failure variants) append on each dispatch.
- **Actor** — `TriggerDispatcher` is the actor coordinating port adapters per trigger kind.
- **Event store** — `createLocalEventStore()` appends ordered trigger facts.
- **Materialized view / projection** — port wiring state (routes, subscribers, workers) is the projection folded from wired edges.
- **Snapshot** — the accepted manifest `triggerEdges` array is the snapshot consumers boot from.
- **Read store** — `firedEvents` on the dispatcher exposes the append-only trigger log for tests and diagnostics.

No durable runtime replay engine here; this names boundaries for promotion to `@hobo/runtime-local`.
