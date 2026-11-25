# SVID Cross-Tenant Guard Contract

Independent POC for HOBO-247. It composes the HOBO-77 workload-attestation intake
and HOBO-90 JWT-SVID issuance contracts into an adversarial regression harness.

## What This Proves

- A tenant-A measured workload that self-asserts tenant B receives a tenant-A
  SVID, never a tenant-B token.
- Requested tenant, parent principal, and code version claims are overridden by
  the host-signed launch measurement.
- Requested scopes are clamped to the inferred grant before issuance.
- Tampered, replayed, or missing attestation fails closed with `token.Denied`.
- Unattested workloads remain pinned to the non-overridable Firecracker microVM
  floor and cannot fall through to a weaker shared tier.

## Boundary

This package does not implement production attestation, policy, executor
selection, or token brokering. It is a branch-local contract harness over the
existing draft seams:

- `src/draft/technical-proofs/workload-attestation-intake-contract`
- `src/draft/technical-proofs/jwt-svid-issuance-contract`
- `src/draft/technical-proofs/identity-event-contract`

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\svid-cross-tenant-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Svid Cross Tenant Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
