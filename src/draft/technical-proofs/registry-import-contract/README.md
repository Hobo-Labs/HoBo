# Registry Import Contract

This draft proof makes HOBO-383 executable without building a production registry service. It composes the existing signed offline bundle, install verification, registry descriptor, and in-boundary mirror boundaries.

## Contract Surface

- `createRegistryImporter()` parses a `registry.bundle/v1` manifest and imports listing payloads into an in-boundary mirror.
- Each listing is verified through the existing install-time signature, provenance, and conformance gate before it can be loaded.
- `createInBoundaryRegistryMirror()` exposes offline discovery, install, and digest serving from imported artifacts only.
- `registry.BundleImported` records per-artifact imported/refused status and precise refusal reasons.
- Missing mirror artifacts fail closed with live crawl disabled.

## Boundary

This slice does not implement the bundle format, production OCI storage, live registry crawl, Junction federation, model provisioning, or the air-gap hardening gates for offline revocation, anti-rollback, and transparency inclusion. It carries those trust materials through the bundle contract; the HOBO-397 hardening proof composes this importer and enforces those gates in [`offline-import-integrity-contract`](../offline-import-integrity-contract/README.md).

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-import-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Registry Import Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
