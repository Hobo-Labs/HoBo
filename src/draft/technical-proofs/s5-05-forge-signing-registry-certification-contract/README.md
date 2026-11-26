# S5-05 Forge Signing, SLSA Provenance & Registry Certification Contract

Independent POC for HOBO-650. Extends the S0-10 signing/provenance chain to Forge
output:

- on certification pass, sign the provider artifact with SLSA provenance and the
  conformance report;
- publish to an in-memory Registry seam (`packages/registry/`) with
  `gen.Certified` and `gen.PluginCertified` events plus full generation
  provenance;
- refuse unsigned or uncertified artifacts at install — they stay unlisted;
- certified fixture provider installs from the Registry and participates in
  Matching without auto-selection;
- tampered signatures fail with typed `forge.signature_verification_failed`; tampered
  artifact bytes fail digest verification with typed `forge.install_verification_failed`.

Composes `generation-certify-stage-contract`, `slsa-provenance-certification-contract`,
`signed-artifact-publish-install-contract`, and `hobo-add-install-verification-contract`.
Does not implement production Registry storage, Forge sandbox certification loop
(S5-04), or signing-key infrastructure.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/s5-05-forge-signing-registry-certification-contract
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
