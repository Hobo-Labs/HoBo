# SVID Auto-Rotation Contract POC

HOBO-99 proof for rotating JWT-SVIDs before expiry during a long-running workload.

This package composes the existing Yard issuer/JWKS, workload-attestation, JWT-SVID, and
identity-event contracts. It models the rotation scheduler contract only:

- Rotate only when the current SVID is inside the configured pre-expiry window.
- Re-attest the workload before rotation and refuse re-issue when attestation is lost.
- Bind the rotated SVID to the attested tenant/code-version and cap scope to current and inferred grants.
- Emit `identity.Rotated` without leaking token material.
- Keep old and new SVID validity continuous through a bounded overlap, then retire the old SVID.

Out of scope: initial SVID issuance, network-partition rotation policy, mTLS certificate rotation,
token-broker cache renewal, and production key management.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\svid-auto-rotation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Svid Auto Rotation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
