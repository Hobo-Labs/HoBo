# mTLS-by-Default Conformance Gate POC

Independent proof for HOBO-181.

This package pins the hardening conformance gate from:

- `docs/design/security-networking.md#plan-12`: mTLS-by-default between services, regardless of connectivity tier.
- `docs/design/adr/02-identity-security.md#adr-0023`: secure-by-default, zero-trust, and tenant-scoped trust domains.
- `docs/design/adr/07-portability-extensibility.md#adr-0042`: local vs Camp fidelity tags, including camp-only cross-cloud mTLS handshakes.
- `src/draft/technical-proofs/mtls-data-path-contract`: HOBO-117's SVID-keyed mTLS decision contract.
- `src/draft/technical-proofs/tier-one-private-network-contract` through `src/draft/technical-proofs/tier-five-public-mtls-contract`: the realized tier seams this gate consumes.

The proof covers:

- All five connectivity tiers must appear in the conformance report before the gate can pass.
- Each tier must prove an SVID-keyed mTLS handshake.
- Plaintext or unauthenticated peer probes must be rejected.
- Cross-tenant trust-domain probes must be rejected.
- Cross-cloud handshakes are tagged `camp`; same-provider/intra-tier handshakes are tagged `local`.
- Camp-only checks cannot be marked green unless the report carries a concrete Camp evidence reference and run timestamp.

Scope boundary: this POC does not issue SVIDs, implement the mTLS data path, provision tiers, configure provider networking, or run real Camp infrastructure. It models the narrow aggregate gate that consumes per-tier proof reports and fails closed on missing, mislabeled, or unauthenticated coverage.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\mtls-by-default-conformance-gate test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Mtls By Default Conformance Gate.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
