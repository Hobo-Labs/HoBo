# HOBO-171 Internal CA / Private ACME Proof

This executable proof pins the air-gapped certificate path from
[Plan 12](../../security-networking.md#plan-12) and
[ADR-0036](../../adr/07-portability-extensibility.md#adr-0036), while reusing
the validation-gate evidence shape established by
[HOBO-144](../hobo-144-acme-dns01-cert-issuance/index.md).

## Contract Surface

- An air-gapped Camp issues certificates through a private ACME endpoint backed
  by an internal CA.
- ACME DNS-01 evidence still flows through the domain validation gate, but the
  issuability signal comes from the in-boundary private ACME endpoint.
- Certificate rotation stays inside the Yard boundary and emits
  `domain.CertRotated` before expiry.
- Public ACME fallback is refused before any egress attempt, with no
  `domain.CertIssued` event.
- CA key references must remain in the Yard boundary via
  `keyref://kms/<boundary>/...`.

## Proof Boundaries

This is branch-local contract proof. It does not implement a full air-gap Yard
profile, bundle import, public ACME DNS-01 integration, SVID/Identity genesis,
or real KMS/HSM internals.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\internal-ca-private-acme-contract test
```

The checks cover zero-egress issuance, validation-gate ACME evidence from a
private endpoint, in-boundary rotation, public ACME fallback refusal, and CA key
boundary validation.
