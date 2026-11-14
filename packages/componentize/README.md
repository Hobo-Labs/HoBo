# @hobo/componentize

Deterministic **TypeScript → wasm component contract artifact → OCI descriptor**
boundary consumed by `examples/hello-bindle`, `hobo build`, and stage-gate /
conformance slices.

## HONEST SCOPE — synthetic wasm contract bytes (not real jco)

**This package does not run a production jco / `componentize-js` / `wasm-tools`
pipeline.** `componentizeHelloBindle` builds **synthetic, contract-shaped wasm
bytes** via `buildWasmContractBytes` in `src/componentize.ts`:

- standard wasm module header / magic (`\0asm` + version)
- a custom section named `hobo.componentize.contract` carrying canonicalized
  JSON metadata (schema, WIT world, pinned toolchain pins, source digests,
  smoke export expectations)

Artifacts are valid enough for `WebAssembly.validate`, digest parity, and
boundary/Pact tests. They are **not** guest modules produced by compiling
TypeScript through the pinned jco/`componentize-js` toolchain. Toolchain version
pins in `PINNED_TOOLCHAIN` document intended real-pipeline targets; the real
pipeline remains deferred (see ship remediation residual **H-E3b**
and known limitation rows in
[`docs/design/known-limitations-register.md`](../../docs/design/known-limitations-register.md)).

Do not market `@hobo/componentize` output as a portable production WASM membrane
until a real componentize path lands.

## Parse, don't validate

`componentizeHelloBindle` parses its epoch and pinned-toolchain inputs up front (failing closed on
skew or nondeterminism) and returns parsed, derived types — `WasmComponentArtifact` and
`ComponentizeResult` — so raw DTOs never cross the build seam. `validateWasmComponentArtifact`
re-parses artifact bytes and contract metadata before any consumer uses them. Wire forms live in
`data-models/componentize.proto` with CUE constraints alongside.

## Position in the event architecture

This package is a pure, deterministic build function: it hosts no actor, appends nothing to an
event store, and maintains no projection or materialized view of its own. Its artifacts enter the
control plane downstream — the build/deploy lanes that consume `@hobo/componentize` record
component digests as events, and the artifact itself is a content-addressed snapshot (digest +
contract metadata) that those read stores reference. Commands and events describing builds are
owned by the consuming packages (`@hobo/cli`, `@hobo/stage-gate`, `@hobo/hobo`), not declared here.

## Pre-release

`@hobo/componentize` is monorepo-internal at `0.0.1` and **not published to npm**
as a supported external toolchain. Ship-target context:
[`docs/design/launch-ship-targets.md`](../../docs/design/launch-ship-targets.md),
[ADR-0139](../../docs/design/adr/07-portability-extensibility.md#adr-0139).
