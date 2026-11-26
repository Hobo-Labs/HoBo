# @hobo/yards — Architecture Evidence

Production home of `yard()`, the cross-Camp provider-specific scope that groups Camps under
one provider id.

## Schema and constraints

- Protobuf records live in [`data-models/topology_yard.proto`](./data-models/topology_yard.proto).
- CUE constraints bound every protobuf type in [`data-models/topology_yard.cue`](./data-models/topology_yard.cue).
- PACT consumer evidence for the yard scope boundary lives under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

Untrusted yard input crosses one parser boundary in `yard(name, config)` and becomes the
deep-frozen derived type `Yard`. Single-provider invariants and camp membership are enforced
at construction; downstream callers receive parsed `Yard` values, not raw config objects.

## Event architecture

Yard values are immutable scope snapshots composed from parsed Camp objects:

- **Command** — `ComposeYard` groups one or more Camps under a shared provider id.
- **Event** — `topology.YardComposed` appends the frozen Yard descriptor to the authoring stream.
- **Actor** — `YardCompositionActor` owns provider-homogeneity checks across member Camps.
- **Event store** — accepted topology events append to the platform event store.
- **Materialized view / projection** — `YardRegistryProjection` folds composed yards into the yard read model.
- **Snapshot** — the deep-frozen `Yard` value is the snapshot carried on `topology.YardComposed`.
- **Read store** — planners and policy surfaces query the yard read store for cross-Camp groupings.
