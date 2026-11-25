# Tier-Four Overlay Mesh Contract POC

Independent proof for HOBO-129.

This package pins the M2 tier-four networking realization contract from:

- `docs/design/security-networking.md`: cross-provider edges without native private peering fall back to a HoBo-managed WireGuard/eBPF overlay mesh.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: HOBO-89's `ConnectivityPlan` and tier enum.
- `src/draft/technical-proofs/tier-three-private-interconnect-contract`: HOBO-127's deterministic handoff to tier 4 when no private interconnect is available.
- `src/draft/technical-proofs/mtls-data-path-contract`: HOBO-117's SVID-keyed mTLS decision contract.

The proof covers:

- A cross-provider bind edge realizes tier 4 as a `wireguard-ebpf` overlay, not public networking.
- The realized link records the tier-3 private-interconnect fall-through reason that sent it to tier 4.
- The overlay mesh kind is pinned to `wireguard-ebpf`; generic overlays fail closed.
- Mesh policy is derived from the bind edge and allows only the bound source and dependency.
- Provider output injection resolves `ctx.bindings.<name>` to the overlay endpoint and re-resolves when the target endpoint changes.
- The consumed mTLS data-path contract accepts only the bound target SVID over the overlay.
- Source and target SVIDs must name the resources on the bind edge.
- An unbound resource sharing the same mesh cannot reach the dependency.
- Overlay-node lifecycle covers create, key rotation, drain, and retire without ever enabling public fallback.
- Overlay-node key loss fails closed.
- Partitioned mesh segments do not silently route over public networking.

Scope boundary: this POC does not call cloud APIs, configure real WireGuard/eBPF, implement tier 5 public+mTLS, build a global data-plane load balancer, implement Junction inference, author governance mesh-policy rules, or change Planner ranking/cost objectives. It models the narrow tier-four realization seam those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tier Four Overlay Mesh Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
