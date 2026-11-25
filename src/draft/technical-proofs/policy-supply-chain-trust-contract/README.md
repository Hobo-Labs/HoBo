# Policy Supply-Chain Trust Contract

This POC pins HOBO-218: adversarial supply-chain trust boundaries for policy
packs, policy packages, registry bundle import, and swapped policy-engine
artifacts.

## Contract Surface

- Policy packages wrap signed policy-pack envelopes with a second signed package
  envelope, CycloneDX SBOM, and SLSA-style provenance.
- Verification rejects unsigned packs, tampered pack payloads, wrong signing
  keys, and federated mandatory-rule downgrade attempts before the pack loads.
- Registry bundle import is deny-by-default, audits `hobo:registry:import`, and
  rejects unsigned or unprovenanced offline bundles.
- Derivative policy-engine swaps verify a signed engine artifact, attested build,
  trusted builder, and seam conformance before returning a governed
  `require-approval` decision.
- Fail-open or unattested policy-engine builds are denied at the trust boundary
  with `runtimeInvoked: false`.

## Boundary

This package attacks the HOBO-150 pack-signing and HOBO-196 attestation
interfaces without implementing production signing, KMS, key rotation,
cross-Yard attestation, registry storage, or CI SBOM/SLSA generation. It is a
deterministic contract proof for the gate behavior those systems must satisfy.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\policy-supply-chain-trust-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Supply Chain Trust Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
