# Patterns & Standards Cross-Links — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Untrusted markdown link targets are parsed once at the boundary into derived
domain types (`LinkScanRoot`, `RottedReference`, `BrokenLink`). Downstream
checks consume those parsed types instead of re-validating raw strings. CUE
constraints bound the same derived types so malformed evidence records are
rejected at parse time.

## Event Architecture

The package's scan result is the read model behind a small event flow:

- **Command** — `ScanPatternsStandardsLinks` requests a hygiene scan.
- **Event** — a successful scan appends `docs.CrossLinksValidated` to the log.
- **Actor** — the link-guard module is the actor applying validation events.
- **Event store** — accepted validation events append to the platform event store.
- **Materialized view / projection** — a projection folds validation events into
  the latest broken-link report.
- **Snapshot** — the returned `{ rottedReferences, brokenLinks }` object is the
  snapshot of that projection.
- **Read store** — CI and draft tests query that snapshot rather than re-scanning
  ad hoc.

No runtime engine is implemented here; this names the command, event, actor, and
projection boundaries for later promotion.
