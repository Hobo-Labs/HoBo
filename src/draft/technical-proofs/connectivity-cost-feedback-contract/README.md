# Connectivity Cost Feedback Contract POC

Independent proof for HOBO-172.

This package pins the M4 networking feedback seam from:

- `docs/design/security-networking.md`: egress, cost, and latency feedback to the Planner.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: HOBO-89's `ConnectivityPlan` and tier enum.
- `src/draft/technical-proofs/tier-three-private-interconnect-contract`: HOBO-127's tier-three cross-provider private edge proof.

The proof covers:

- Per-edge egress and latency estimates keyed to the realized connectivity tier.
- Topology annotation data for each `bind` edge: tier, estimated egress, estimated latency, and rating.
- Planner feedback records that downstream Planner/cost-model work can consume without this package implementing those decisions.
- Same-region edges rate as near-zero egress while cross-cloud private interconnect edges rate higher.
- Tier changes are detected when an existing topology annotation still carries stale tier/cost/latency values.
- Missing egress cost data is labeled `unrated` and never silently reported as `$0`.

Scope boundary: this POC does not implement Planner colocation objectives, the cost model engine, dashboard rendering, provider billing reconciliation, or tier realization. It models the narrow data contract those surfaces consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Connectivity Cost Feedback Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
