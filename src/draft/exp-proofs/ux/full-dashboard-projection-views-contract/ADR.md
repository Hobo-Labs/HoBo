# Full Dashboard Projection Views Contract - Architecture Evidence

Architecture-guard evidence for `scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- PACT contract under [`architecture/pacts/`](./architecture/pacts).

## Parse, Don't Validate

Untrusted dashboard render input crosses `parseDashboardRenderResult` once and
becomes `ParsedDashboardRenderResult`. Nested constrained values become derived
types such as `RenderedDashboardView`, `WcagAuditResult`, and
`PseudoLocalizationResult`. Downstream HTML renderers and audit helpers accept
those parsed derived types instead of re-checking broad DTOs. CUE constraints
bind the same shapes so malformed view inventories are rejected at parse time.

## Event Architecture

- **Command** — `RenderFullDashboardFromProjections`.
- **Event** — `deployment.*`, `topology.*`, `run.*`, `registry.*`, `credential.*`,
  `policy.*`, `cost.*`, `drift.*`, and `stream.*` families from the
  multi-cloud-shop fixture.
- **Actor** — `DeploymentProjectionActor`, `TopologyProjectionActor`,
  `RunProjectionActor`, `RegistryProjectionActor`, `CredentialAuditActor`,
  `CostProjectionActor`, `DriftProjectionActor`, and `StreamProjectionActor`.
- **Event store** — replayable fixture history only; no production store here.
- **Materialized view / projection** — each dashboard view reads a named
  `*View` projection (`DeploymentView`, `TopologyView`, `RunView`, etc.).
- **Snapshot** — parsed `DashboardRenderResult` is the snapshot consumers render.
- **Read store** — fixture-only reference reads for HTML, WCAG, and
  pseudo-localization audits; no Gateway subscription or GraphQL facade.

No runtime engine, projector, Next.js UI, or production read store is
implemented here. This proof names the command, event, actor, projection,
snapshot, read-store, PACT, protobuf, and CUE boundaries for S6-07.

## Status

Accepted for HOBO-662 proof work. Blockers S6-05/S6-06 remain unmerged; this
package composes projection fixtures without importing their production runtime.

## Alternatives Rejected

- Build production `apps/dashboard` in this issue: rejected until blockers merge.
- Skip WCAG/pseudo-loc gates: rejected — NFR-016 is explicit acceptance.

## Performance Applicability

Not applicable. Deterministic in-memory fixture composition only.
