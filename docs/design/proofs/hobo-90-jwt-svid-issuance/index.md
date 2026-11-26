# HOBO-90 JWT-SVID Issuance Proof

This executable proof pins the M2 issuance contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06),
[Plan 21](../../authoring-resources-wiring.md#plan-21),
[ADR-0008](../../adr/02-identity-security.md#adr-0008),
[ADR-0012](../../adr/02-identity-security.md#adr-0012),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and
[ADR-0027](../../adr/02-identity-security.md#adr-0027).

## Contract Surface

- The issuer accepts only `attested` workload verdicts from the attestation intake seam.
- The JWT-SVID subject uses the tenant bound by attestation, not caller-provided request claims.
- Requested `(port, resource, action)` scope is intersected with the inferred manifest grant.
- Issued JWT-SVIDs validate through the Yard issuer JWKS and use the existing JWT-SVID claim shape.
- Successful issuance records `identity.Issued` with SVID reference, scoped grant, and expiry.

## Proof Boundaries

This proof composes the local contract POCs for HOBO-71, HOBO-77, HOBO-44, and the identity-event
contract. It does not implement key rotation, OIDC federation exchange, production attestation,
deny-by-default capability policy, token-broker narrowing, provider STS exchange, or mTLS
certificate issuance. Those remain separate identity, policy, broker, and provider slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\jwt-svid-issuance-contract test
```

The checks prove JWKS verification for attested workloads, scope clamping to inferred grants,
attestation-derived tenant subjects, refusal for unattested workloads, and `identity.Issued`
emission without token leakage.
