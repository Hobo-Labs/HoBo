# S1-15 Bind Wiring + Topology Contract — Architecture Evidence

Integrated draft package for HOBO-605. Combines bind-reference wiring and
topology scope objects behind parse-once boundaries.

## Schema And Constraints

- Protobuf shapes: [`architecture/s1_15_bind_wiring_topology_contract.proto`](./architecture/s1_15_bind_wiring_topology_contract.proto)
- CUE constraints: [`architecture/s1_15_bind_wiring_topology_contract.cue`](./architecture/s1_15_bind_wiring_topology_contract.cue)
- PACT boundaries: [`architecture/pacts/`](./architecture/pacts)

## Parse, Don't Validate

This package applies **parse, don't validate**: untrusted input crosses one parser
boundary and becomes **parsed domain types** / **derived types**:

- `parseResourceId` — branded `ResourceId`
- `compileBindleManifest` — frozen `HoboManifest` after one validation pass
- `camp` / `yard` — deep-frozen topology value objects
- `resolveLocalBindings` — accepts parsed `Camp` + `HoboManifest`, never raw JSON DTOs

## Event Architecture

Manifest collection and binding resolution are modeled as immutable snapshots in the
**event store**, folded by an **actor** into **materialized view** / **projection**
**read store** outputs:

- **Command** — `CollectBindleWiring`, `WrapTopology`, `ResolveLocalBindings`
- **Event** — `ManifestCollected`, `BindingsResolved`
- **Actor** — bindle collector / camp resolver aggregates
- **Event store** — append-only authoring events (not implemented in this draft)
- **Materialized view / projection** — `hobo.manifest/v1` graph + resolved env map
- **Snapshot** — golden manifest fixture + resolved local endpoints
- **Read store** — downstream lowerer and runtime-local harness consumers query snapshots

No runtime engine is implemented here; this names the boundaries for production
promotion into `@hobo/bindles`, `@hobo/camps`, `@hobo/yards`, and
`@hobo/runtime-local`.
