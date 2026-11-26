# hobo add Install Verification Contract

This draft proof pins HOBO-365's install-time boundary for `hobo add`.
It composes the registry descriptor contract with the HOBO-7 signed artifact
verification primitive, then records a verified artifact as available to Matching.

## Contract Surface

- `hoboAdd` parses a digest-only registry descriptor before install.
- The signed artifact candidate is verified for digest binding, signature, SLSA provenance,
  trusted builder identity, and passing conformance through HOBO-7.
- Failed verification returns precise reasons and leaves the catalog unchanged.
- Successful install marks the listing `availableToMatching: true` and
  `selectedByMatching: false`.
- Cost and mirror callbacks are accepted only as proof probes; install never invokes them
  before verification and does not use them to select an artifact.

## Boundary

This is a deterministic POC for the install gate only. It does not implement version or dependency
resolution, mirror selection, cost tiebreaking, Matching selection, air-gap import, trust-tier
minimum policy authoring, production Sigstore/Cosign, or registry transport.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-add-install-verification-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Add Install Verification Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
