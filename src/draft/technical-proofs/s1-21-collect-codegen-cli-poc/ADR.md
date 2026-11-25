# S1-21 Collect + Codegen CLI POC — Architecture Evidence

Integrated draft POC for HOBO-611 carrying architecture-guard evidence for
both `hobo collect` and `hobo codegen --check` authoring verbs.

## Schema And Constraints

- Protobuf envelope shapes live in [`data-models/`](./data-models).
- CUE constraints bound collect and codegen envelope fields.
- Consumer pacts under [`contracts/pacts/`](./contracts/pacts) pin the
  CLI→collector-engine and CLI→codegen-pipeline boundaries.

## Parse, Don't Validate

Raw engine/pipeline outputs cross exactly one parser boundary into typed
`CollectEnvelope` / `CodegenResult` derived types. Downstream rendering and
file I/O accept only the parsed derived types.

## Event Architecture

The CLI is a read-side renderer of engine facts:

- **Command** — `hobo collect` and `hobo codegen` are read-only authoring
  commands that invoke the collector engine or codegen pipeline.
- **Event** — successful collection appends `bindle.ResourcesCollected` and
  `bindle.ManifestProduced` events (rendered from engine facts, not persisted
  here).
- **Actor** — the collector engine is the actor that applies collection events
  in order during `collectBindleResources`.
- **Event store** — production will append accepted events to the platform
  event store; this POC returns events to the caller without persistence.
- **Materialized view / projection** — the manifest IR is the projection
  consumers query; the CLI renders it without mutating read models.
- **Snapshot** — `hello-bindle.manifest.json` is the committed snapshot of the
  collection projection for CI byte-equality gates.
- **Read store** — downstream surfaces (`hobo plan`, deploy) query the manifest
  read store rather than re-running collection; the CLI does not write there.

`collect` and `codegen --check` mutate nothing; `codegen` write mode touches
only `.hobo/generated/` and `src/_generated/`.
