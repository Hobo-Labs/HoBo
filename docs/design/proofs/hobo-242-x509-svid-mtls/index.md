# HOBO-242 X.509-SVID mTLS Proof

This executable proof pins the M2 service-to-service identity contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06),
[Plan 12](../../security-networking.md#plan-12), and
[ADR-0008](../../adr/02-identity-security.md#adr-0008).

## Contract Surface

- Identity issues X.509-SVID certificates for attested workloads using
  `spiffe://yard/<tenant>/<bindle>/<resource>` as the SAN URI.
- mTLS verification accepts only SVID-CA-signed peer certificates from the expected tenant trust
  bundle.
- Certificates rotate before TTL expiry and keep a handoff overlap for existing sessions.
- Air-gapped Yards use the internal CA/private ACME path and require no phone-home.
- Audit events record `identity.Issued` and `identity.Rotated` using SVID references, not private
  key material.

## Proof Boundaries

The proof composes the existing identity-event contract and the SVID issuance/rotation semantics
from HOBO-90 and HOBO-99. It covers normal pre-expiry renewal overlap, not ADR-0100 partition-grace
vectors. It does not implement JWT-SVID issuance, mesh/connectivity tier selection, Relay reverse
tunnels, public endpoint mTLS gateway configuration, or production ACME/TLS handshakes.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\x509-svid-mtls-contract test
```

The checks prove fixture mTLS, SPIFFE SAN contents, private-key possession, rotation overlap,
tenant trust-domain rejection, air-gap issuance, cross-tenant SPIFFE refusal, expiry rejection, and
tampered SAN signature failure.
