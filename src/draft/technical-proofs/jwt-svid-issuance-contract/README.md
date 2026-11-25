# JWT-SVID Issuance Contract POC

HOBO-90 proof for issuing JWT-SVIDs only after workload attestation binds the run.

## What This Proves

- An `attested` workload verdict can receive a JWKS-verifiable JWT-SVID.
- The SVID subject tenant is derived from the attestation binding, not request claims.
- Requested scope is clamped to the inferred manifest grant and never widened.
- `unattested` workloads are refused issuance instead of silently receiving a weaker token.
- Successful issuance records an `identity.Issued` event without leaking token material.

## Boundary

This package composes the existing Yard issuer/JWKS, workload-attestation, JWT-SVID, and
identity-event contracts. It does not implement signing-key rotation, OIDC federation exchange,
attestation verification, deny-by-default capability policy, token-broker narrowing, provider STS
exchange, or mTLS certificate issuance.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\jwt-svid-issuance-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Jwt Svid Issuance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
