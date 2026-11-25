# HOBO-77 Workload Attestation Intake Proof

This executable proof pins the M1 workload-attestation intake contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06), [ADR-0008](../../adr/02-identity-security.md#adr-0008),
and [ADR-0012](../../adr/02-identity-security.md#adr-0012).

## Contract Surface

- Attestation documents include a host-signed launch measurement.
- The verified binding includes run id, tenant, parent principal, code version,
  and component-image digest.
- Host-signature validation happens before Identity trusts caller-provided claims.
- Unknown image digests, forged signatures, missing signatures, and stale
  measurements return `unattested`.
- `unattested` maps to a non-overridable `firecracker-microvm` policy floor.

## Proof Boundaries

This proof uses a fixture host attestor to exercise the intake seam. It does not
implement production Firecracker attestation, KMS-backed host key discovery, SVID
minting, executor placement, cross-tenant policy denial, or broker token exchange.
Those remain separate identity, executor, and policy slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\workload-attestation-intake-contract test
```

The checks prove valid attestation, tamper/forgery/absence failures, measured
tenant binding, stale measurement rejection, and the mandatory microVM fallback
for unattested workloads.
