# HOBO-4 Componentize Proof

HOBO-4 is proven by the focused POC at [`src/draft/technical-proofs/hobo-componentize-contract`](../../../../src/draft/technical-proofs/hobo-componentize-contract/README.md).

S0-07 draft implementation (real `componentize-js` + `jco` toolchain) lives at [`src/draft/technical-proofs/hobo-componentize`](../../../../src/draft/technical-proofs/hobo-componentize/README.md) pending promotion to `packages/componentize/` now that S0-06 (`@hobo/wit`) has merged. HOBO-603 spike evidence is at [`src/draft/technical-proofs/componentize-js-determinism-spike`](../../../../src/draft/technical-proofs/componentize-js-determinism-spike/README.md).

**S1-23 integration (HOBO-613):** `hobo build` is promoted to
[`packages/cli`](../../../../packages/cli/README.md) (command + digest parity tests) and
consumes [`@hobo/componentize`](../../../../packages/componentize/README.md);
golden digest `sha256:c0d38866fc7ad727a9c2bf877919fb5aa0a3f8a5057f6bd59b55f38f8fe8dfc0`.
Draft rollup evidence remains at
[`src/draft/projects/s1-23-hobo-build`](../../../../src/draft/projects/s1-23-hobo-build/README.md).

Acceptance mapping:

- `hello-bindle` builds into a deterministic wasm component artifact envelope and OCI descriptor.
- Rebuilds produce stable `inputsDigest` and smoke output under `SOURCE_DATE_EPOCH`, sorted inputs, path remapping, and pinned toolchain fields. **Byte-identical wasm** from `componentize-js@0.21.0` is **not** asserted at S0 — see [ADR-0105](../../adr/01-architecture-core.md#adr-0105) and the [HOBO-603 spike](../../../../src/draft/technical-proofs/componentize-js-determinism-spike/README.md).
- The Wasmtime-shaped smoke check invokes the `health` export and returns `hello-bindle:ok`.
- Adversarial guards fail closed on `Date.now()` source nondeterminism and jco version skew, and publish the pinned Ubuntu/Windows CI matrix tuple.

Scope note: this is a walking-skeleton contract proof. Real `componentize-js`/jco execution, `wasm-tools` CLI validation, Wasmtime execution, non-TS language paths, Dagger/container builds, and signing remain owned by downstream build/provider/signing slices.

**Promotion (S0-11 / HOBO-588):** the production seed fixture now lives at [`examples/hello-bindle`](../../../../examples/hello-bindle/README.md). `@hobo/componentize` on `packages/componentize/` supplies the consumed build API.
