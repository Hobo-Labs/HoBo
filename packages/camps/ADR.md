# @hobo/camps — Architecture Evidence

Production home of `camp()`, provider selection descriptors, resolution precedence,
and offline `resolveLocalBindings` for local Camp dev. Camps are **provider-neutral
until Yard-attached**; the Yard owns cloud provider selection ([yard-first-placement](../../docs/design/adr/yard-first-placement.md)).

## Schema and constraints

- Protobuf records live in [`data-models/topology_camp.proto`](./data-models/topology_camp.proto).
- CUE constraints bound every protobuf type in [`data-models/topology_camp.cue`](./data-models/topology_camp.cue).
- PACT consumer evidence for the camps → runtime-local binding resolver boundary lives under
  [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

Untrusted provider mapping input crosses parser boundaries in `providerSelection(...)` and
`camp(...)` and becomes deep-frozen derived types (`ProviderSelection`, `Camp`). Camp ids,
env names, and resolution precedence tables are normalized once at construction; downstream
functions accept parsed `Camp` values, not raw DTOs with repeated boolean checks.

## Event architecture

Topology scope objects are immutable value objects; collection emits content-addressed manifest
snapshots through the deployment stream:

- **Command** — `ComposeCamp` records a provider-agnostic bindle inside a Camp mapping.
- **Event** — `topology.CampComposed` appends the frozen Camp descriptor to the authoring stream.
- **Actor** — `CampCompositionActor` owns Camp normalization and Yard-inferred single-provider invariants (Camps do not author cloud provider pins).
- **Event store** — accepted topology events append to the platform event store.
- **Materialized view / projection** — `CampRegistryProjection` folds composed camps into the camp read model.
- **Snapshot** — the deep-frozen `Camp` value is the snapshot carried on `topology.CampComposed`.
- **Read store** — `resolveLocalBindings` and planners query the camp read store for precedence tables.
