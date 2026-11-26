# Registry Compromise Guard Contract

This draft proof pins HOBO-393's adversarial registry-compromise boundary. It composes the existing
install verification, listing-yank lifecycle, and pinned-digest registry fetch contracts into one
standing hardening harness.

## Contract Surface

- Install refuses bit-flipped signed artifacts before catalog registration.
- Conformance evidence is bound twice: the descriptor's certified report digest must match the
  signed candidate report digest, and the report must name the artifact digest it certified.
- A post-publish Capability Spec regression is handled by fresh re-verification, not by trusting the
  author-time snapshot. Regression yanks the listing, blocks new deploy/redeploy, flags pinned Sets,
  and raises the existing critical remediation obligation.
- A compromised registry that serves substituted bytes for a verified coordinate is caught by the
  consumer's pinned digest check.
- A valid signature is only an integrity and conformance signal. It does not prove benignity.

## Residual Window

This proof intentionally documents the remaining window for a validly-signed-but-malicious artifact,
compromised signing key, compromised builder, or forged report from the same compromised pipeline.
Those are constrained here by fresh re-verification and the yank path after disclosure. Offline revocation, anti-rollback, and transparency-inclusion are owned by the air-gap integrity slice.

## Boundary

This is an adversarial contract harness only. It does not implement production Sigstore/Cosign,
registry transport, continuous scanner scheduling, dependency-confusion resolution, offline
revocation, transparency logs, anti-rollback, key-management internals, or SRE migration execution.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-compromise-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Registry Compromise Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
