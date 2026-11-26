# HOBO-247 SVID Cross-Tenant Guard Proof

This proof hardens the keyless workload-identity path against confused-deputy
tenant minting by generated, forked, or compromised workloads.

Design refs:

- [ai-native-agent-auth.md](../../ai-native-agent-auth.md#plan-06)
- [ADR-0008](../../adr/02-identity-security.md#adr-0008)
- [ADR-0012](../../adr/02-identity-security.md#adr-0012)
- [ADR-0023](../../adr/02-identity-security.md#adr-0023)

Executable artifact:

- [`src/draft/exp-proofs/dx/svid-cross-tenant-guard-contract`](../../../../src/draft/exp-proofs/dx/svid-cross-tenant-guard-contract)

Acceptance evidence:

- Tenant A workload assertions for tenant B are overridden by the host-signed
  launch measurement, and the issued JWT-SVID is tenant-A bound.
- Tampered component-image digest evidence fails attestation, emits
  `token.Denied`, and returns the non-overridable `firecracker-microvm` floor.
- Replayed or stale attestation documents fail closed and emit `token.Denied`.
- Missing attestation from a fork cannot fall through to a weaker shared tier.
- Scope widening in the request is clamped to the inferred grant before issuance.

Scope boundary:

- No production Firecracker attestation or host-key distribution.
- No executor isolation backend implementation.
- No policy-engine implementation beyond asserting the denial/audit result.
- No token-broker flow changes; the proof targets SVID issuance safety.
