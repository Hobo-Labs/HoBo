# Offline Import Integrity Contract

This draft proof pins HOBO-397's air-gap import hardening gates for signed
offline bundles.

## Contract Surface

- `createOfflineIntegrityImporter()` wraps the existing `hobo registry import`
  proof and only delegates to it after all air-gap gates pass.
- The offline revocation gate binds the imported revocation material to the
  bundle reference and rejects any listing signed by a revoked key.
- The anti-rollback gate rejects an older build timestamp or version unless an
  operator supplies an explicit audited force-downgrade.
- The transparency gate verifies each listing and base-image inclusion proof
  against the pinned log root using only imported proof material.
- Every refusal is recorded on a `registry.BundleImported` audit event with the
  named failed gate.
- Missing revocation or transparency material fails closed instead of attempting
  live repair egress.

## Boundary

This package does not define the offline bundle format, production OCI storage,
KMS/HSM internals, live registry compromise recovery, or the happy-path mirror
importer. It composes:

- [`signed-offline-bundle-contract`](../signed-offline-bundle-contract/README.md)
  for the M0 bundle schema and trust-material declarations.
- [`registry-import-contract`](../registry-import-contract/README.md) for
  signature/provenance/conformance verification and in-boundary mirror loading.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\offline-import-integrity-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Offline Import Integrity Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
