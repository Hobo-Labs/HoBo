# ADR-0064 UI Generation Citation Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

Untrusted citation-check input (repo root path and target doc list) is parsed once at the boundary
into derived domain types (`CitationCheckResult`, `UiGenerationCitationReport`). Downstream
assertions consume those parsed types instead of re-scanning raw filesystem paths or ad hoc regex
lists.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `RecordUiGenerationCitationCheck` requests validation of the REM-037 target docs.
- **Event** — a successful command appends a `uiGenerationCitation.CheckCompleted` event.
- **Actor** — the UI-generation citation aggregate applies accepted events in order.
- **Event store** — accepted events append to the platform event store as the durable source of truth.
- **Materialized view / projection** — a projection folds events into the latest citation check report.
- **Snapshot** — the accepted `CitationCheckResult[]` snapshot is what tests assert against.
- **Read store** — downstream surfaces query that read store rather than the raw event log.

No runtime engine, projector, or event store is implemented here; this is a design-time contract
that names the command, event, actor, and projection boundaries so later implementation inherits a
consistent vocabulary.
