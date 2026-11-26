# HOBO-145 Build Wasm Provider Contract

This package is an independent POC for the `@hobo/build-wasm` BuildProvider
adapter. It proves the source-to-wasm-component build seam without implementing
the real `@hobo/componentize` toolchain, container fallback, VM/microVM builds,
Workload Profile selection, or BuildMachine host selection.

Acceptance mapping:

- `createBuildWasmProvider().build(spec)` returns a deterministic
  `ImageRef` for a wasm-component OCI artifact.
- Rebuilding the same fixture `BuildSpec` produces the same component digest and
  manifest reference using pinned toolchain versions, pinned toolchain digests,
  and `SOURCE_DATE_EPOCH`.
- TypeScript, Rust, and TinyGo fixture sources route through distinct declared
  wasm toolchains.
- The emitted `ImageRef` wires back through the fixture provider `IacProgram`
  using `wireBuildOutputs(...)`.
- `runBuildWasmConformance(...)` gates the claimed provider shape,
  reproducibility, caller-supplied IAC wire-back, and non-wasm fail-closed
  behavior.
- Adversarial guards fail closed for toolchain digest/version drift, missing
  source language toolchains, oversized components, invalid bytes, and core-wasm
  modules that are not component-model artifacts.

Run it with:

```powershell
npm.cmd --prefix src/draft/technical-proofs/build-wasm-provider-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Build Wasm Provider Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
