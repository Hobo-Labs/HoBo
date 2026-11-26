# Internal CA / Private ACME Contract

Independent POC for HOBO-171. It composes the HOBO-144 DNS-01 certificate
contract with an air-gapped Yard profile: certificate issuance and rotation stay
inside the boundary, use a private ACME endpoint backed by an internal CA, and
present the same validation-gate evidence shape as public ACME.

## Contract Surface

- `requestInternalCaPrivateAcmeCertificate()` issues a certificate for an
  air-gapped Camp through private ACME only.
- `rotateInternalCaPrivateAcmeCertificate()` renews inside the boundary and
  emits `domain.CertRotated`.
- `createAirGapNetworkGuard()` fails closed on any attempted public egress.
- `createInternalCaPrivateAcmeAuthority()` keeps CA key material behind an
  in-boundary KMS reference and rejects external key refs.

## Proof Boundaries

This proof does not implement a real private ACME server, public ACME, the
air-gap Yard bundle/import profile, Identity genesis, or KMS/HSM internals. It
pins the adapter contract and failure semantics the runtime implementation must
preserve.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\internal-ca-private-acme-contract test
```

The checks cover zero-egress issuance, validation-gate ACME evidence from a
private endpoint, in-boundary rotation, public ACME fallback refusal, and CA key
boundary validation.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Internal Ca Private Acme Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
