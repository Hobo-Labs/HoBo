# Provider Aws Full Capability Catalog Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted capability manifests and plan resources are parsed once at the provider
boundary into derived catalog-port types. Downstream `realize()` and conformance
checks consume those parsed types instead of re-validating raw DTOs. The CUE
constraints bound the same derived types so malformed input is rejected at parse
time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `RegisterProvider`, `PlanDeployment`, or `ApplyDeployment` requests
  a catalog change or realization.
- **Event** — a successful command appends `provider.Registered`,
  `deployment.Planned`, `deployment.PlanRejected`, or `deployment.Applied` to the
  log.
- **Actor** — the AWS provider aggregate is the actor that applies planning and
  apply events in order.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — a projection folds the event store into the
  Capability Manifest and DeploymentPlan read models consumers query.
- **Snapshot** — the accepted manifest record is the snapshot of that projection.
- **Read store** — downstream surfaces query that read store rather than the raw
  event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
