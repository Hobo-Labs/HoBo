# @hobo/junctions — Architecture Evidence

Production home of `junction()`, the cross-cloud federation scope that groups peer Yards
and derives their connectivity plane from declared member manifests.

## Schema and constraints

- Protobuf records live in [`data-models/junction.proto`](./data-models/junction.proto).
- CUE constraints bound every protobuf type in [`data-models/junction.cue`](./data-models/junction.cue).
- PACT consumer evidence for the junction↔yard membership boundary lives under
  [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

Untrusted junction input crosses one parser boundary in `junction(name, config)` and
becomes the deep-frozen derived types `JunctionDefinition` and `JunctionMemberManifest`.
Membership, name, and capability invariants are enforced at construction with typed
`JunctionParseError`s; downstream derivations receive parsed values, not raw config
objects.

## Event architecture

Junction values are immutable federation snapshots composed from parsed Yard objects:

- **Command** — `ComposeJunction` federates two or more peer Yards; `DeriveJunctionPlan`
  derives the connectivity plane from their manifests.
- **Event** — `topology.JunctionComposed` appends the frozen JunctionDefinition to the
  authoring stream; `junction.PlanDerived` records each derived connectivity plan.
- **Actor** — `JunctionPlanningActor` owns tier selection and per-pair edge derivation;
  no actor here mutates member Yards, which keep their own event logs.
- **Event store** — accepted topology and junction events append to the platform event
  store; nothing crossing the junction is shared mutable state.
- **Materialized view / projection** — `JunctionPlanProjection` folds derived plans into
  the per-yard read model that `planForYard` mirrors: each yard sees only its own halves,
  DNS obligations, and federation deliveries.
- **Snapshot** — the deep-frozen `JunctionDefinition` is the snapshot carried on
  `topology.JunctionComposed`; the frozen `JunctionConnectivityPlan` is the snapshot
  carried on `junction.PlanDerived`.
- **Read store** — dispatchers and policy surfaces query the junction read store for
  cross-cloud peering, DNS, and federation-record groupings.
