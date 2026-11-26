# Component-Host Conformance Suite POC

Independent HOBO-29 proof for the `@hobo/conformance/component-host`
portability boundary.

## What This Proves

- `runtime-local` (`wasmtime/46.0.1`) and `wasm-in-container`
  (`wasmtime-container/46.0.1`) fixtures both pass the same component-host
  conformance suite.
- The suite asserts deterministic-clock trace replay, `wasi:*` round-trip,
  link late-binding, and capability-handle isolation.
- The suite also pins determinism-relevant host behavior: floating-point/NaN
  canonicalization, fuel/epoch scheduling, and resource-limit semantics.
- Manifest IR pins host kind plus version before planning; incompatible host
  versions fail with `component_host.host-version-incompatible`.
- A conformance report must exercise every manifest-certified host kind/version
  pair, so `runtime-local` cannot pass as a stand-in for `wasm-in-container`.
- Cross-host checks compare both host equivalence and the expected reference
  semantics for replay, WASI round-trip, and link late-binding.
- Wall-clock scheduling jitter and host-specific partial-failure timing are
  declared non-covered divergences, not implied-equivalent behavior.

## Boundary

This is the component-host conformance proof only. It intentionally excludes
membrane/backpressure conformance hooks, generic runtime-port suites, provider
conformance, and concrete Wasmtime or OCI execution.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\component-host-conformance-suite test
```

## Promotion note (S1-10 / HOBO-599)

Promoted to `packages/conformance/src/suites/component-host/` (production). Draft proof retained for historical evidence.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Component Host Conformance Suite.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
