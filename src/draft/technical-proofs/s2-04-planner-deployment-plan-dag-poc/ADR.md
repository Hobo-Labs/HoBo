# S2-04 Planner DeploymentPlan DAG POC — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted manifest
IR is parsed once at the `planManifest()` boundary into derived domain types
(`DeploymentPlan`, `ResourcePlan`, control-plane events), and downstream
consumers receive those parsed, derived types instead of re-checking raw input.
The CUE constraints bound the same derived types so malformed input is rejected
at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `PlanRequested` (manifest IR + deploy context submitted to the Planner).
- **Event** — `deployment.Planned`, `match.Decided`, or `deployment.PlanRejected`.
- **Actor** — the Yard Planner actor applies planning commands in order.
- **Event store** — accepted planning events append to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — deployment timeline projection folds planning
  events into the auditable DeploymentPlan read model.
- **Snapshot** — the content-addressed `DeploymentPlan` is the snapshot of that projection.
- **Read store** — orchestrator and CLI surfaces query that read store rather than
  the raw event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.

## Deferred To Production (S2-03+)

- Region/colocation objective ranking beyond catalog tie-break
- Camp mapping sugar compilation
- Gateway command ingress wiring in `@hobo/cloud`
