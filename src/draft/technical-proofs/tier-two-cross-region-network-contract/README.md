# Tier-Two Cross-Region Network Contract POC

Independent proof for HOBO-124.

This package pins the M2 tier-two networking realization contract from:

- `docs/design/security-networking.md`: same-provider cross-region connectivity uses provider backbone + private peering where available.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: HOBO-89's `ConnectivityPlan` and tier enum.
- `src/draft/technical-proofs/tier-one-private-network-contract`: HOBO-121's endpoint injection and bind-scoped reachability pattern.
- `src/draft/technical-proofs/mtls-data-path-contract`: HOBO-117's SVID-keyed mTLS decision contract.

The proof covers:

- A same-provider cross-region bind edge realizes tier 2 over private provider backbone peering, not public networking.
- `ctx.bindings.<name>` resolves from cross-region provider output injection and re-resolves when the target endpoint output changes.
- The consumed mTLS data-path contract accepts only the bound target SVID.
- Reachability is scoped exactly to the bound source and dependency.
- Unsupported region pairs fall through deterministically to the next declared fallback, preferring overlay before any public+mTLS handoff.
- Public fallback is explicit and review-gated; it is never silently selected.
- Residency-constrained edges are refused when the target region is outside the allowed boundary.

Scope boundary: this POC does not call a cloud provider, create real VPC/VNet peering, implement cross-provider tiers 3-5, build Junction inference, change Planner ranking/cost objectives, implement egress-cost feedback, or build provider IaC internals. It models the narrow tier-two realization seam those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tier Two Cross Region Network Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
