# Vibe Deployment Dashboard Mockups - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-544. It
states how the mockup fixture is parsed, how field groups stay projection-backed,
how the HOBO-577 quickstart fixture ids constrain downstream dashboard copy, and
which runtime work remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeDeploymentDashboardMockups` checks the raw mockup fixture at the
boundary and returns `ParsedVibeDeploymentDashboardMockups`. Downstream proof
code consumes the parsed domain type rather than passing raw strings and
rechecking projection source, freshness, owner, tenant/RBAC disposition, proof
mode, HOBO-577 quickstart fixture id, and safe next action in each view.

## Event Architecture

This package does not implement dashboard runtime. It names the event model that
later runtime work must preserve:

- **Command** - `dashboardMockup.Accept` records an accepted mockup fixture.
- **Event** - `dashboardMockup.Accepted` appends the wireframe, field group,
  scenario, proof-mode, and accessibility evidence.
- **Actor** - `DashboardMockupActor` owns the parsed fixture and rejects
  production UI, provider, projection, GraphQL, RBAC, or launch-claim creep.
- **Event store** - accepted mockup evidence is appended to the platform event
  store as design-time evidence.
- **Materialized view / projection** - `DashboardMockupView` folds accepted
  events into the read model consumed by later visual and prototype slices.
- **Snapshot** - the parsed HOBO-544 record is replayable from its accepted
  event and carries field-group freshness labels.
- **Read store** - later M2 prototype work reads the snapshot, not issue-body
  text or live provider state.

No production dashboard frontend, visual graph renderer, projection engine,
GraphQL facade, live provider traversal, tenant/RBAC implementation, or launch
readiness claim is implemented here.
