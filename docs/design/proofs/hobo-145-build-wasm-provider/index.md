# HOBO-145 Build Wasm Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0005](../../adr/01-architecture-core.md#adr-0005).

The executable POC in
[`src/draft/technical-proofs/build-wasm-provider-contract`](../../../../src/draft/technical-proofs/build-wasm-provider-contract/README.md)
proves the M1 `@hobo/build-wasm` BuildProvider skeleton:

- a fixture `BuildSpec` produces a reproducible wasm-component OCI `ImageRef`
  using pinned toolchain versions and digests;
- TypeScript, Rust, and TinyGo fixture sources route through distinct declared
  wasm toolchains;
- the `ImageRef` feeds back into the fixture provider `IacProgram`;
- the conformance helper gates provider identity, reproducibility, wire-back,
  and non-wasm target rejection;
- toolchain drift, missing source-language toolchains, oversized components,
  invalid bytes, and core-wasm modules that are not component-model artifacts
  fail closed with precise `BuildWasmError` codes.

Scope kept out: real `@hobo/componentize` execution, container fallback,
VM/microVM builds, Workload Profile selection, BuildMachine host routing, OCI
registry publication, and downstream runtime execution.
