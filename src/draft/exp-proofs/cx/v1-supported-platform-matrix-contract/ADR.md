# V1 Supported Platform Matrix — Architecture Evidence (HOBO-511, M0)

This note records the architecture evidence required by the repository
guardrails for the M0 contract. It is design evidence only: no device lab,
browser grid, live e2e execution, or runtime implementation is provided here.

## Schema sources of truth

- **Protobuf** — `proto/supported_platform_matrix.proto` defines the data shapes
  and records exchanged across the compatibility boundary
  (`DesktopBrowserSupport`, `PlatformSupport`, `SupportClaim`,
  `UnsupportedReportRoute`, `CompatibilityMatrixPublished`,
  `UnsupportedEnvironmentClassified`) and the `SupportLevel` enum.
- **CUE** — `cue/supported_platform_matrix.cue` constrains every protobuf type
  with the customer-facing value rules (support levels, allowed evidence
  sources, route destinations, non-empty fields).
- **PACT** — `contracts/pacts/supported-platform-matrix-projection.pact.json` is
  the executable contract for the projection boundary between the support-routing
  read model and the compatibility-matrix event store.

## Parse, don't validate

Inbound environment reports and matrix revisions are not re-validated ad hoc at
every call site. They are parsed once at the boundary into **derived domain
types** whose existence proves the invariants already hold:

- A raw environment report is parsed into a `ParsedEnvironmentReport` derived
  type only after the CUE constraints pass; downstream routing accepts the
  parsed type and never the raw payload.
- A raw matrix revision is parsed into a `ParsedCompatibilityMatrix` derived
  type carrying validated browser/platform rows. Code that cannot produce the
  parsed type cannot publish a support claim.

Following parse, don't validate, the parsed/derived types are the only shapes
the projection consumes, so a malformed or evidence-less row is unrepresentable
past the boundary rather than defended against repeatedly.

## Event architecture

The contract is modeled as an event-sourced, CQRS-style boundary:

- **Command** — `PublishCompatibilityMatrix` and `ClassifyUnsupportedEnvironment`
  are the commands the release owner and support operator issue; each command is
  gated by the evidence-source and routing rules in the contract.
- **Events** — accepted commands emit immutable events
  (`CompatibilityMatrixPublished`, `UnsupportedEnvironmentClassified`).
- **Actor** — the release-owner actor owns matrix publication and is the single
  writer for the matrix stream; the support-operator actor owns unsupported
  report classification.
- **Event store** — events are appended to the compatibility-matrix event store,
  the append-only system of record for the support contract timeline.
- **Materialized view / projection** — the supported-environment view is a
  projection (a materialized view) built by folding events into current support
  claims and routing decisions.
- **Snapshot** — periodic snapshots of the projection bound replay cost so the
  support-routing read model can be rebuilt without replaying the full event
  store.
- **Read store** — support routing and docs are served from a read store
  populated by the projection; the read store holds only customer-facing support
  levels, evidence sources, and routes.

All of the above is M0 design evidence; implementation of a live device lab,
automated browser grid, and live e2e execution remains gated behind M0
acceptance per the scope-out in the contract.
