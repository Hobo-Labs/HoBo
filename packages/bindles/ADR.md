# @hobo/bindles — Architecture Evidence

Production home of `hobo.manifest/v1`, the deployment intermediate representation
consumed by the Planner/Orchestrator and rendered by publishers/IaC adapters.

## Schema and constraints

- Protobuf records live in [`data-models/proto/hobo/manifest/v1/manifest.proto`](./data-models/proto/hobo/manifest/v1/manifest.proto).
- CUE constraints bound every protobuf type in [`data-models/cue/hobo_manifest_v1.cue`](./data-models/cue/hobo_manifest_v1.cue).
- PACT consumer/provider evidence lives under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

Untrusted manifest JSON crosses one parser boundary in `parseManifest(input: unknown)`
and becomes the branded derived type `ManifestV1`. Downstream consumers receive
parsed manifests through `serializeManifest`, `canonicalManifestHash`, and
`aspireFallbackEnv` — never raw DTOs with repeated boolean checks. Violations throw
`ManifestParseError` with a path-precise field name.

## Event architecture

The manifest is an immutable, content-addressed snapshot carried by the
`deployment.Planned` event:

- **Command** — `RegisterManifest` records a parsed manifest in the Manifest IR Registry.
- **Event** — `deployment.Planned` appends the manifest snapshot hash to the deployment stream.
- **Actor** — `ManifestRegistryActor` owns manifest registration and hash assignment.
- **Event store** — accepted deployment events append to the platform event store.
- **Materialized view / projection** — `ManifestRegistryProjection` folds registrations into the current registry read model.
- **Snapshot** — the `ManifestV1` value is the snapshot carried on `deployment.Planned`.
- **Read store** — Planner/Orchestrator and publishers query the registry read store by content hash.

No runtime engine is implemented here; this package defines the parse boundary and
registry pact so later slices inherit a consistent vocabulary.
