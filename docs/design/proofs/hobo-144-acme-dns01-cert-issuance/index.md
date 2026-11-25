# HOBO-144 ACME DNS-01 Certificate Issuance Proof

This executable proof pins the secretless DNS-01 certificate path from
[Plan 12](../../security-networking.md#plan-12),
[ADR-0035](../../adr/07-portability-extensibility.md#adr-0035), and
[ADR-0027](../../adr/02-identity-security.md#adr-0027).

## Contract Surface

- Identity prepares the DNS-01 order and holds certificate key material behind a
  `keyref://identity/...` reference.
- The challenge TXT record is staged only through the HOBO-101 `hobo:dns`
  shadow path for the Yard's Camps before validation.
- The validation gate reads the ACME issuability signal from the staged
  challenge path before `domain.CertIssued`.
- Rotation emits `domain.CertRotated` before expiry.
- Renewal failure emits `domain.CertRenewalFailed` and an obligation-engine
  replayable `policy.ObligationCreated`.
- Provider-managed certificates are represented as an explicit per-Camp adapter
  seam, not as a second built-in runtime.

## Proof Boundaries

This is branch-local contract proof. It does not call a public ACME CA, mutate a
live DNS zone, implement SVID issuance, implement internal/private ACME for
air-gapped Yards, or wire provider-managed certificate APIs.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\acme-dns01-cert-issuance-contract test
```

The checks cover shadow-only DNS-01 issuance across multiple Camps, wildcard
cert coverage, no static certificate secret persistence, pre-expiry rotation,
renewal-failure obligation escalation, live-zone mutation denial, and
provider-managed adapter shape.
