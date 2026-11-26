# HOBO-4 Componentize Contract

This POC proves the `@hobo/componentize` walking-skeleton contract for a TypeScript `hello-bindle` service:

- deterministic source collection with `SOURCE_DATE_EPOCH`, sorted file order, path remapping, and pinned tool versions;
- a wasm component artifact envelope with the OCI component media type and stable SHA-256 digest;
- an OCI descriptor that points at that component digest;
- a Wasmtime-shaped health smoke invocation;
- fail-closed guards for nondeterministic source and toolchain skew, plus the pinned CI matrix tuple.

The real language toolchains stay out of scope here: cargo-component, TinyGo, Dagger/container builds, signing, and provider build-machine execution belong to their own slices. This package is the branch proof for the contract shape those tools must satisfy.

**Promotion (S0-11 / HOBO-588):** the production seed fixture now lives at [`examples/hello-bindle`](../../../../examples/hello-bindle/README.md).

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-componentize-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Componentize Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
