# Workload Attestation Intake Contract POC

HOBO-77 proof for the workload-attestation intake seam consumed by SVID issuance.

## What This Proves

- Attestation documents carry a host-signed launch measurement with run id, tenant,
  parent principal, code version, component-image digest, and isolation tier.
- A valid host signature over a known component-image digest yields an `attested`
  verdict with the identity binding the issuer needs.
- Tampered, forged, unsigned, unknown-image, or stale measurements fail closed to
  `unattested`.
- Tenant and parent-principal binding comes from the measured launch, not caller
  claims.
- `unattested` always maps to the non-overridable Firecracker microVM floor.

## Boundary

This is an executable contract POC, not production Firecracker attestation. It does
not mint SVIDs, choose the executor isolation backend, perform policy deny checks, or
implement real host public-key distribution. Those stay with the issuance, executor,
and policy slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\workload-attestation-intake-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Workload Attestation Intake Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
