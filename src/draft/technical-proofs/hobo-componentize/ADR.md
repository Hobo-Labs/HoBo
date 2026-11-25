# Hobo Componentize — Architecture Evidence

Draft POC for HOBO-584 / S0-07. Carries architecture-guard evidence for deterministic TS→wasm component→OCI builds.

## Schema and constraints

- Protobuf records: `data-models/componentize.proto`
- CUE constraints bound every protobuf message in `data-models/componentize.cue`
- Executable pact: `contracts/pacts/componentize-build-boundary.pact.json`

## Parse, don't validate

`parseComponentizeSpec` is the only raw-input boundary. Parsed `ComponentizeSpec` and `WasmComponentArtifact` derived types flow through `componentizeService`, `validateWasmComponentArtifact`, `buildOciDescriptor`, and `runComponentSmoke`.

## Event architecture

- **Command** — `ComponentBuildRequested`
- **Event** — `ComponentBuilt`
- **Actor** — build actor emits events; no in-place read-model mutation
- **Event store** — append-only command/event log
- **Projection** — `ComponentizeResult`
- **Snapshot** — component bytes + OCI descriptor returned to callers
- **Read store** — downstream consumers read the snapshot/projection

## Toolchain note

This POC uses real `@bytecodealliance/componentize-js@0.21.0` and `@bytecodealliance/jco@1.24.3` against a vendored `hobo:sdk` WIT skeleton from the draft wit-toolchain proof. Promotion to `packages/componentize/` swaps the vendored WIT tree for `@hobo/wit` when S0-06 merges.
