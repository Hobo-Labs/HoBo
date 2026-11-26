# Resource Pack Distribution Contract

This draft proof makes HOBO-228 executable without building a production Registry, signing stack,
or Matching engine. It composes the existing signed artifact fixture with a provider Resource Pack
install boundary and an air-gapped offline bundle import fixture.

## Contract Surface

- Provider code and default Resource Definitions are bundled as a versioned Resource Pack artifact.
- Publish attaches conformance report subject digests plus SLSA-style provenance through the
  existing signed artifact primitive.
- `hobo add` and `hobo pack add` verify signature, provenance, content hash, and conformance before
  registering definitions as Matching-available.
- Matching can select installed definitions from Camp-level provider and IaC driver preferences
  without per-resource manifest config.
- Equal-scoring decisions include the catalog content hash and candidate pack hashes so winner
  changes are attributable.
- Signed offline bundles import the same packs inside the Yard boundary and enforce anti-rollback
  state.

## Boundary

This package intentionally stops before Registry index/listing lifecycle, production Sigstore/SLSA
implementation, capability-indexed discovery, full Matching scoring, monetization, revocation-list
internals, and general anti-rollback policy. Those are separate HoBo slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\resource-pack-distribution-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Resource Pack Distribution Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
