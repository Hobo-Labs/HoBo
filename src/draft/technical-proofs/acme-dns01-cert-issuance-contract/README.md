# ACME DNS-01 Certificate Issuance Contract

Independent POC for HOBO-144. It composes the existing `hobo:dns` shadow
write contract and the domain validation gate to prove certificate issuance and
rotation can be driven by Identity without storing static certificate secrets.

## Contract Surface

- `requestAcmeDns01Certificate()` prepares a DNS-01 order through Identity,
  stages the challenge TXT record through the pre-validation `hobo:dns` shadow
  port for the Yard's Camps, validates issuability, and emits
  `domain.CertIssued`.
- `rotateAcmeDns01Certificate()` renews inside the configured expiry window and
  emits `domain.CertRotated`.
- Failed renewal emits `domain.CertRenewalFailed` plus an obligation-engine
  replayable `policy.ObligationCreated` before expiry instead of silently
  allowing certificate expiry.
- `requestProviderManagedCertificate()` is the opt-in per-Camp provider-managed
  certificate seam for ACM/App Service/Google-managed style adapters.

## Proof Boundaries

This proof does not implement public ACME, provider APIs, Identity SVID
issuance, internal/private ACME for air-gapped Yards, or live DNS promotion.
All DNS challenge writes remain on the shadow path.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\acme-dns01-cert-issuance-contract test
```

The checks cover DNS-01 shadow issuance across multiple Camps, wildcard subject
coverage, no static private-key material in persisted surfaces, early rotation,
renewal-failure obligation escalation, live-zone mutation denial, and the
provider-managed adapter seam.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Acme Dns01 Cert Issuance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
