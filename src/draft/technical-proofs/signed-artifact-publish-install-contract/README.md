# Signed Artifact Publish/Install Contract

This draft proof makes the HOBO-7 registry trust boundary executable without implementing a
production registry. It models publish-time artifact signing plus SLSA-style provenance and
install-time verification before an artifact can enter Matching.

## Contract Surface

- Publish normalizes an artifact to a digest-pinned URI and signs the artifact reference,
  SLSA-style provenance, and conformance report with an Ed25519 fixture key.
- Install recomputes the digest, verifies the signature, checks provenance subject binding,
  requires a trusted sandbox builder identity, and enforces a minimum provenance tier.
- A verified artifact becomes available to Matching but is not selected automatically.
- Install refuses tampered artifacts, unsigned artifacts, failing conformance reports, untrusted
  builders, weak provenance tiers, and coordinate or digest confusion.

## Boundary

This is a deterministic contract slice for signed artifact publication and install verification.
It does not implement registry listing lifecycle, production Sigstore/Cosign integration, key
rotation, transparency-log lookup, revocation, anti-rollback, offline bundle import, or malicious
publisher detection beyond verified integrity metadata.

## S0-10 promotion note

S0-10 ([HOBO-587](https://linear.app/quickdeploy-ai/issue/HOBO-587)) extends this contract in
[`../componentize-artifact-trust-contract/README.md`](../componentize-artifact-trust-contract/README.md)
with typed `ArtifactVerificationRefusedError`, event projections, and CI `artifact-trust` gate.
Production promotion target: `packages/componentize/src/publish/`.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\signed-artifact-publish-install-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Signed Artifact Publish Install Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
