# Signed Offline Bundle Contract POC

This POC pins the M0 `registry.bundle/v1` contract for HOBO-350.

It defines:

- A signed offline-bundle manifest for air-gapped `hobo registry import`.
- Digest-only references for registry descriptors, base images, optional model weights, SLSA provenance, conformance reports, revocation lists, and transparency inclusion proofs.
- Required offline trust material: signed revocation/key-expiry material, anti-rollback state, and a pinned transparency-log root.
- A `registry.BundleImported` audit event with named verification gates.

Scope intentionally stops before import transport, signature verification, mirror storage, and adversarial runtime enforcement. Those remain separate slices.

## Verification

Run the focused contract suite:

```bash
npm.cmd --prefix src\draft\technical-proofs\signed-offline-bundle-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Signed Offline Bundle Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
