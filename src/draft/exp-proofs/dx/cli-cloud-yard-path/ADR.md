# CLI Cloud Yard Path - Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-625.

## Schema And Constraints

- Protobuf shapes: [`architecture/cli_cloud_yard_path.proto`](./architecture/cli_cloud_yard_path.proto)
- CUE constraints: [`architecture/cli_cloud_yard_path.cue`](./architecture/cli_cloud_yard_path.cue)
- PACT boundary: [`architecture/pacts/cli_cloud_yard_path.pact.json`](./architecture/pacts/cli_cloud_yard_path.pact.json)

## Parse, Don't Validate

Gateway responses are parsed once into derived types (`LoginResult`, `PlanResult`,
`DeployResult`, `InspectDeployResult`, `LogsResult`, `ActionableError`). CLI command helpers accept
only parsed derived types; raw HTTP bodies do not leak past the Gateway seam. The CUE constraints
bound the same derived types so invalid remediation lists or fixture-id drift are rejected at parse
time.

## Event Architecture

- **Command** — `cliCloudYardPath.JourneyRequested` asks the proof to run the hello-bindle cloud
  path against the mocked Yard Gateway.
- **Event** — `cliCloudYardPath.JourneyAccepted` records the J1 step transcript, fixture id, and
  actionable-error samples.
- **Actor** — the CLI cloud-path proof owner applies accepted journey events in order.
- **Event store** — accepted journey events append to the platform event store as the durable source
  of truth.
- **Projection** — `DeploymentView` materialized view for `hobo inspect deploy`.
- **Snapshot** — the current deployment projection seq/state is the snapshot used by inspect and
  logs commands.
- **Read store** — downstream promotion to `packages/cli/contracts/` inherits the PACT shapes
  defined here.

No live Yard, production CLI binary, or Gatekeeper engine is implemented in this package.
