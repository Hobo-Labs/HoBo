# V1 Release Notes Private Beta Evidence Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

Untrusted evidence input is parsed once with `assertReleaseNotesPrivateBetaEvidence()`, producing a
derived private-beta evidence record. The parsed domain types are `ReleaseNotesPrivateBetaEvidenceRecord`,
`RequiredEvidence`, `RecordedBlocker`, `AcceptedRisk`, and `ReleaseCutlineDependency`. Downstream
functions such as `canCompletePrivateBetaGate()` consume those parsed types instead of re-checking
loose DTO fields.

## Event Architecture

The accepted evidence record is the read model behind a small release-governance flow:

- **Command** - record or revise the release-notes private-beta evidence gate.
- **Event** - append a release-note evidence gate event after validation.
- **Actor** - the release-readiness gate aggregate applies evidence and risk events in order.
- **Event store** - accepted events are appended as the durable launch-readiness source.
- **Materialized view / projection** - a projection folds evidence, blockers, risks, cutline
  dependencies, and parent-status updates into the gate record.
- **Snapshot** - the accepted HOBO-466 record is the M2 private-beta snapshot.
- **Read store** - release owners query the read store instead of raw events.

No runtime gate service, projector, or event store is implemented here.
