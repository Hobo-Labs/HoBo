# Iac Pulumi Automation Adapter — Architecture Evidence

Draft package for HOBO-621 carrying architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Untrusted `IacProgram` input is parsed once through `validateIacProgram()` into
frozen derived types (`ParsedIacProgram`). Downstream adapter methods accept only
parsed derived types; output references are resolved at the binding boundary.

## Per-Resource Stack Model

Each resource reconciles through its own stack (`deploymentId/resourceName`),
matching ADR-0006 and the S2 IaC state model in
`docs/design/control-plane.md`. Destroy walks resources in reverse order so
compensation can target individual stacks.

## Event Architecture

The adapter's accepted outputs are the read model behind ResourceActor reconcile:

- **Command** — `preview`, `apply`, `refresh`, `destroy` on an `IacProgram`.
- **Event** — successful apply emits provisioned outputs captured as bindings.
- **Actor** — one ResourceActor per resource holds the stack lease.
- **Event store** — accepted events append to the platform event store as durable truth.
- **Materialized view / projection** — stack outputs fold into `resource.Provisioned` bindings.
- **Snapshot** — the accepted outputs record is the snapshot of that projection.
- **Read store** — downstream surfaces query the read store rather than the raw event log.

No runtime engine is implemented here; this names the seams for S2 production
promotion.
