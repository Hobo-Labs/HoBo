# DeploymentPlan IR contract POC

Independent proof for HOBO-41.

This package pins the M0 `DeploymentPlan` / `ResourcePlan` contract from:

- `docs/design/control-plane.md`: Planner emits a content-addressed `DeploymentPlan` DAG.
- `docs/design/platform-engineering.md`: co-provisioned nodes and output placeholders flow through the graph.
- `docs/design/architecture.md`: the Yard Planner produces the DAG that ResourceActors drive.

The proof covers stable plan content addressing, placeholder grammar, `MatchContext`, dependency DAG validation, unresolved placeholder references, and co-provisioned node id collisions.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Deployment Plan Ir Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
