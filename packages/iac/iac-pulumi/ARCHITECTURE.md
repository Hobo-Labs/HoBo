# @hobo/iac-pulumi — Architecture Evidence

Production IaC backend for S2-05. Promotes the Pulumi Automation API adapter from
`src/draft/technical-proofs/s2-06-iac-pulumi-automation-adapter/` into
`packages/iac/iac-pulumi/`.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the IaC program spec,
  preview diff, drift report, apply outputs, and state-backend config.
- CUE constraints in `data-models/iac_pulumi.cue` bound every protobuf message and
  enum in that schema.
- PACT consumer evidence for the IaC backend boundary lives under
  [`contracts/`](./contracts) and is exercised by `contracts/consumer`.

## Parse, don't validate

`validateIacProgram` is the single parse, don't validate boundary: an untrusted
`IacProgram` DTO becomes a frozen, derived parsed domain program (checked
apiVersion/kind/provider, unique resources, resolvable `${resources.X.outputs.Y}`
references) before any preview or apply runs. Callers receive derived parsed
domain types instead of re-checking raw fields, and `PORT`-shaped adapters depend
on the `IacProvider` contract in `src/port.ts`, built through `@hobo/core`.

## Per-resource stack model

`createPerResourceStackKey` maps each resource to `deploymentId/resourceName`, one
Pulumi stack per resource, so a failed apply cannot corrupt unrelated resources.

## Event architecture

- **Command** — a Yard/resource-actor `apply` (or `preview`/`refresh`/`destroy`)
  request against an `IacProgram`.
- **Event** — `iac.PreviewComputed`, `iac.ApplySucceeded`, `iac.ApplyDiverged`,
  `iac.PartialApplyFailed`, and `iac.DriftDetected` facts emitted per stack key.
- **Actor** — the per-resource stack aggregate applies those events in order and
  holds the state-backend lock while it does.
- **Event store** — accepted events append to the platform event store as the
  durable source of truth for each per-resource stack.
- **Materialized view / projection** — the drift report folds applied/failed
  stack events into a per-resource `drifted` projection.
- **Snapshot** — the per-resource-stack state written to the state backend is the
  snapshot of that projection.
- **Read store** — `refresh` and `outputsToBindings` query that snapshot rather
  than replaying the raw event log.
