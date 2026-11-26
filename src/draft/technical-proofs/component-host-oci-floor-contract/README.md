# Component Host OCI Floor POC

HOBO-28 proof for packaging the Wasmtime component host as the zero-infra `wasm-in-container` floor.

## What This Proves

- A `wasm-in-container` host package carries endpoint, link, and config inputs in the manifest.
- The package is an OCI-shaped descriptor requiring only a container runtime, not SpinKube or provider-native wasm.
- The in-container host reuses the runtime-local Wasmtime host semantics and serves the same fixture request.
- The conformance check compares asserted component-host behavior rather than bit identity.
- Divergent container behavior fails closed before a Camp can select the host.

## Boundary

This is a contract POC, not a real Docker build. It intentionally leaves SpinKube/provider-native adapters, non-wasm OCI fallback, and the broader component-host conformance suite to their own slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\component-host-oci-floor-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Component Host Oci Floor Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
