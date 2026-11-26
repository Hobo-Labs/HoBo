# Yard topology manifest contract POC

Independent proof for HOBO-94.

This package pins the M0 Yard topology / connectivity-manifest contract from:

- `docs/design/architecture.md`: `Bindle -> Camp -> Yard -> Junction` scope breadth and Yard provider ownership.
- `docs/design/security-networking.md#plan-12`: the Junction infers cross-Yard connectivity from member Yard manifests.
- `docs/design/adr/07-portability-extensibility.md#adr-0043`: the Junction folds Yard manifests and emits each Yard its own half without shared mutable state.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: the HOBO-89 `ConnectivityTier` values consumed by cross-Yard links.

The proof covers:

- `YardManifest` v1 schema artifact and typed declaration surface.
- Pure projection from declared topology to a stable, content-hashed manifest with no live network adapter access.
- Fixture two-provider topology with provider zones, exposed endpoints, and cross-Yard link DNS rules.
- Topology override declarations for inferred DNS record sets and link-scoped connectivity tiers.
- Required provider and residency fields.
- Fail-closed rejection when an exposed endpoint is outside the Yard provider/regions.
- Deterministic conflict surfacing when a topology override disagrees with an inferred DNS rule.

Scope boundary: this POC does not implement Junction folding, DNS realization, provider networking, or `bind` authoring. It only defines and validates the Yard-side manifest consumed by those later slices.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Yard Topology Manifest Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
