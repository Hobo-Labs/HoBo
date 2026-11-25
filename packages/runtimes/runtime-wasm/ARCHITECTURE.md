# @hobo/runtime-wasm — Architecture Evidence

Camp component host for **wasm** (Wasmtime OS-process sandboxes). Extracted from
the composed `isolated-wasm` path so host backends are separate CLI packages.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT consumer evidence lives under [`contracts/`](./contracts).

## Parse, don't validate

Resource names and paths cross resolve boundaries once (`resolvePrivateWasmGuest`).
Invalid empty resource names and missing modules throw at the boundary; sandbox
boot accepts only resolved paths and pinned toolchain binaries.

## Component host — event architecture

- **Command** — ensure toolchain; prepare/componentize guest; boot sandbox; invoke HTTP.
- **Event** — progress emissions mirror lifecycle (toolchain ready, componentized, sandbox ready).
- **Actor** — each private component is a wasmtime process actor.
- **Event store** — durable yard log remains owned by the composition root.
- **Materialized view / projection** — isolation metadata (`isolateBoundary`, wasm paths).
- **Snapshot** — cached componentize outputs under `$HOBO_HOME/sandboxes/<resource>/<hash>`.
- **Read store** — mesh handlers + loopback URLs exposed to the Camp mesh.
