# Aspire WaitFor Parity Audit Architecture

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Competitor markdown is parsed once by `auditAspireWaitForParity` into derived types
`AspireWaitForParityAuditResult` and `AspireWaitForTrackerRow`. Tests consume those
derived types and do not re-parse raw markdown with ad hoc checks.

## Event Architecture

- **Command** — `AuditAspireWaitForParity`.
- **Event** — `competitor.AspireWaitForParityAudited`.
- **Actor** — the intent-alignment remediation actor owns one audit snapshot.
- **Event store** — accepted audit results append to the design-contract event store.
- **Projection** — GAPS.md / aspire.md remediation consumers read the audit projection.
- **Snapshot** — this proof package and Pact fixture are the current review snapshot.
- **Read store** — HOBO-703 remediation reads the snapshot rather than manual grep.

No production orchestrator behavior is implemented here.
