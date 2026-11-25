# HOBO-71 Yard Identity Issuer Proof

This executable proof pins the M1 contract for the Yard Identity OIDC issuer and JWKS surface from
[Plan 6](../../ai-native-agent-auth.md#plan-06), [Plan 12](../../security-networking.md#plan-12),
and [ADR-0008](../../adr/02-identity-security.md#adr-0008).

## Contract Surface

- OIDC discovery exposes the stable Yard issuer URL and JWKS URI.
- JWKS contains public signing keys only; JWT-SVID signatures verify through those public keys.
- Genesis key continuity survives seed to self-deploy handoff.
- Rollover publishes old and new key IDs during the validation overlap.
- Air-gapped mode has no external network dependency and keeps trust roots in-boundary.

## Proof Boundaries

This proof is a contract POC. It does not issue production SVIDs, implement attestation intake,
perform token exchange, serve HTTP, integrate a real KMS/HSM, run HA broker cache, or issue mTLS
certificates. It proves the issuer/JWKS seam those later slices consume.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\yard-identity-issuer-contract test
```

The checks prove discovery/JWKS validation, stable issuer handoff, rollover overlap, air-gap
no-phone-home behavior, non-exportable durable keys, and rejection of self-deploy root regeneration.
