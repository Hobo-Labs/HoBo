# Deployment Dashboard Topology Scope Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its accepted scope
record is parsed and how later runtime work should map the record onto HoBo's
event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package treats the accepted M0 scope as a parsed domain type. The scope
record is checked once at the boundary by
`parseDeploymentDashboardTopologyScope`, which returns the derived
`ParsedDeploymentDashboardTopologyScope` type. Downstream consumers use the
parsed surface taxonomy, evidence gate, and owner map instead of passing raw
strings through repeated ad hoc checks.

## Event Architecture

The package does not implement runtime event storage. It names the event
architecture later M1+ issues must preserve:

- **Command** - `deploymentDashboardTopologyScope.Accept` records an accepted
  scope and evidence gate.
- **Event** - `deploymentDashboardTopologyScope.Accepted` appends the accepted
  scope, projection source map, and follow-up gate.
- **Actor** - `DeploymentDashboardTopologyScopeActor` owns the accepted M0
  record and rejects scope creep before follow-up issues are created.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - `DeploymentDashboardTopologyScopeView`
  folds accepted events into the read model used by M1 design slices.
- **Snapshot** - the accepted M0 record is the replayable snapshot for dashboard
  and topology follow-up planning.
- **Read store** - downstream M1 work reads the snapshot and evidence gate, not
  issue-body text or raw PR discussion.

No dashboard UI, live provider resolver, projection engine, GraphQL facade,
RBAC runtime, status-page publisher, or support workflow is implemented here.
