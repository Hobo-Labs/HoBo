# Region Objective Ranking Contract

POC for HOBO-81. It proves the deterministic Planner selection step that applies region and colocation constraints, then ranks full candidates by the configured objective before the stable definition-id tiebreak.

The module consumes a pinned catalog snapshot and deploy context only. It performs no live provider calls, clock reads, random selection, or model calls. The resulting `match.Decided` and `deployment.Planned` events carry the objective, ranking rationale, catalog hash, and tie state needed for replay.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Region Objective Ranking Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
