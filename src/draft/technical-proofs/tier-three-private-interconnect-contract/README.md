# Tier-Three Private Interconnect Contract POC

Independent proof for HOBO-127.

This package pins the M2 tier-three networking realization contract from:

- `docs/design/security-networking.md`: cross-provider private connectivity uses provider interconnects such as PrivateLink, Private Service Connect, or Private Link when the equivalence class supports it.
- `docs/design/adr/07-portability-extensibility.md#adr-0043`: the Junction may infer PrivateLink/PSC as the private cross-cloud tier, while each Yard owns its own half.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: HOBO-89's `ConnectivityPlan` and tier enum.
- `src/draft/technical-proofs/tier-two-cross-region-network-contract`: HOBO-124's deterministic fallback and endpoint-injection shape.
- `src/draft/technical-proofs/mtls-data-path-contract`: HOBO-117's SVID-keyed mTLS decision contract.

The proof covers:

- A cross-provider bind edge whose equivalence class supports a native private interconnect realizes tier 3, not overlay or public networking.
- Provider output injection resolves `ctx.bindings.<name>` to the private cross-provider endpoint and re-resolves when the target endpoint output changes.
- The consumed mTLS data-path contract accepts only the bound target SVID across the interconnect.
- Reachability is scoped exactly to the bound source and dependency.
- Equivalence classes without private interconnect support fall through deterministically to tier 4 overlay before any tier 5 public+mTLS handoff.
- Public fallback is explicit and review-gated; it is never silently selected first.
- Half-provisioned interconnects are detected and rolled back so one open side is not left reachable.

Scope boundary: this POC does not call a cloud provider, provision real PrivateLink/PSC/Private Link resources, implement the tier 4 overlay fallback, implement tier 5 public+mTLS, build Junction inference, change Planner ranking/cost objectives, implement egress-cost feedback, or build provider IaC internals. It models the narrow tier-three realization seam those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tier Three Private Interconnect Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
