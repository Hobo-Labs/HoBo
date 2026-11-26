# Tier-One Private Network Contract POC

Independent proof for HOBO-121.

This package pins the M1 tier-one networking realization contract from:

- `docs/design/security-networking.md`: `bind` edges derive endpoint resolution, least-privilege network authorization, and same-provider same-region native private networking.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: HOBO-89's `ConnectivityPlan` and tier enum.
- `src/draft/technical-proofs/mtls-data-path-contract`: HOBO-117's SVID-keyed mTLS decision contract.

The proof covers:

- A same-provider same-region bind edge realizes tier 1 with native private-network metadata.
- Security rules are scoped exactly to the bound source and dependency.
- `ctx.bindings.<name>` resolves from provider output injection and re-resolves when the endpoint output changes.
- An unbound peer in the same native network is denied.
- The consumed mTLS data-path contract accepts the bound target SVID.
- Non-tier-one plans fail closed instead of realizing adjacent tiers.

Scope boundary: this POC does not call a cloud provider, create VPCs/VNets, implement tiers 2-5, build Junction inference, change Planner ranking, or implement provider IaC internals. It models the narrow tier-one realization seam those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tier One Private Network Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
