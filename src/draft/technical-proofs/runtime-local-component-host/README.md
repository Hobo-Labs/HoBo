# Runtime-Local Component Host POC

HOBO-17 proof for the `runtime-local` `component-host` skeleton.

## What This Proves

- A Wasmtime-shaped engine seam owns component instantiation.
- A static link table binds a component import to a provider export.
- A `wasi:http/incoming-handler@0.2.0` guest fixture can serve a request and call a linked local `wasi:http/outgoing-handler@0.2.0` provider.
- Component traps fail the call without killing the host.
- Component teardown releases leases and removes link-table routes.

## Boundary

This is a local skeleton, not the cross-host membrane. It intentionally leaves cross-process lattice transport, container packaging, deny-by-default grant inference, deterministic-clock replay, and fuel/epoch execution limits to their own slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runtime-local-component-host test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runtime Local Component Host.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
