# ADR: Dapr Bindings and Distributed Lock Parity Stays Anchor-Honest

Status: Accepted for HOBO-699 branch proof

## Context

`docs/competitors/dapr.md` bundled Bindings and Distributed lock into a ✅
near-1:1 row even though Bindings has only partial coverage through
`hobo:blob-events`, `hobo:scheduler`, and handler triggers, and Distributed
lock is adjacent actor lease/fencing semantics rather than a general lock API.

## Decision

HOBO-699 keeps the competitor tracker honest by:

- splitting Bindings and Distributed lock into their own 🔜 rows with design
  anchors;
- refusing ✅ parity without anchors through an executable audit package;
- documenting the remediation in `GAPS.md` as `REM-033 (for GAP-025)`.

The package applies parse, don't validate discipline: markdown input is parsed
once into `DaprParityAudit` derived domain types, and downstream checks consume
parsed types instead of re-validating raw table cells.

Event architecture remains design-time only for this POC. A later
implementation would accept a `CompetitorParityAuditRequested` command, emit
`CompetitorParityAuditAccepted` or `CompetitorParityAuditRejected` events, and
let a `CompetitorParityAuditActor` append those events to an evidence event
store. A `CompetitorParityProjection` would build a materialized view for
competitor parity rows, record snapshots for branch evidence, and publish a
read store for downstream doc gates. HOBO-699 only names those command/event,
actor, event-store, projection, snapshot, and read store boundaries.

## Consequences

Bindings and Distributed lock cannot silently upgrade to ✅ without a future
design pass that adds committed ports or iteration hooks. The audit package
locks the regression guard in CI through TypeScript tests, protobuf shape, local
CUE constraints, and a Pact-style mocked response fixture.
