# S0-04 Schema Codegen Pipeline — Architecture Evidence

Build-time schema tooling; no runtime event store. Evidence satisfies `scripts/check-architecture-guardrails.mjs`.

## Schema and constraints

- Protobuf shapes: `packages/schema-tools/data-models/`, `packages/core/data-models/`, and [`architecture/`](./architecture).
- CUE constraints bound every protobuf type (`#CodegenReport`, `#DriftEntry`, `#CueViolation`, `#EventEnvelope`).
- PACT contract: [`packages/schema-tools/contracts/pacts/`](./packages/schema-tools/contracts/pacts/).

## Parse, don't validate

Raw CLI `argv`, buf stdout, and cue stderr cross one parser boundary into derived types
(`CodegenInvocation`, `CodegenReport`, `CueVetResult`). Downstream code never re-checks
primitives; parsed derived types are the only values passed inward.

## Event architecture (build-time evidence flow)

- **Command** — `CodegenInvocation` requests write or check against package `data-models/`.
- **Event** — `CodegenReport` records CLEAN/DRIFT/ERROR as append-only CI evidence.
- **Actor** — `hobo-codegen` CLI is the actor applying deterministic generation.
- **Event store** — CI logs retain JSON envelopes; no mutable runtime state.
- **Materialized view / projection** — checked-in `src/_generated/` is the projection consumers import.
- **Snapshot** — each `_generated/` tree is the snapshot of the protobuf sources at generation time.
- **Read store** — editors and tests read `_generated/` directly without a build step.

No runtime engine is implemented; this names boundaries for promotion to `packages/schema-tools/`.
