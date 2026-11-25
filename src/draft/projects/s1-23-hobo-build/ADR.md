# ADR: S1-23 hobo build draft POC

## Context

HOBO-613 wires `hobo build` to `@hobo/componentize` with deterministic artifacts,
codegen drift gating, and OCI fallback for non-wasm guests.

## Parse, don't validate

Untrusted `argv`, bindle service declarations, and manifest JSON cross exactly one
parser boundary (`src/parse.ts`) and become **parsed derived types**
(`BuildRequest`, `ServiceDeclaration`, `BuildManifest`). Downstream `runBuild`
never re-checks raw strings.

## Event architecture

Build state is append-only **events** emitted by the build **actor** (CLI
orchestrator). The **event store** is the in-memory `BuildEvent[]` list during
`runBuild`. The **materialized view** / **projection** is `BuildManifest`
materialized once via `projectBuildManifest`. Failed builds leave no partial
**snapshot** on disk; successful builds write artifact bytes plus manifest
**read store** files under `.hobo/build/`.

| Concern | This POC | Production slices |
|---|---|---|
| Command | `build.Requested` | `hobo build` verb |
| Events | `build.Started`, `build.ArtifactProduced`, `build.Completed` | same |
| Actor | CLI orchestrator | `@hobo/cli` |
| Event store | In-memory event list | durable camp store (later) |
| Projection | `BuildManifest` | `.hobo/build/build-manifest.json` |
| Snapshot | Per-artifact wasm/OCI bytes | `.hobo/build/artifacts/*` |
| Read store | Manifest + artifact paths | local build cache |

## Injectable componentize seam

`runBuild` accepts `componentize` for tests. Default adapter delegates to
`hobo-componentize-contract` and calls `validateWasmComponentArtifact` before
returning wasm bytes.

## Determinism controls

`SOURCE_DATE_EPOCH` defaults to fixed `2026-01-01T00:00:00.000Z`. Sorted service
names, stable JSON serialization, and componentize contract pins enforce digest
parity with the S0-07 golden fixture.

## Boundaries

- Consumer: `@hobo/cli` (this POC's `createBuildCli`)
- Provider: `@hobo/componentize` (draft `componentizeHelloBindle`)
- Pact: `contracts/cli-componentize-boundary.pact.json`
