# REM-038 Stage-6 Notify Separation Architecture

Docs-drift proof only. No runtime service boundary ships here.

## Schema And Constraints

[`proto/stage6_notify_separation.proto`](./proto/stage6_notify_separation.proto) defines the
`Stage6LaneSeparationRecord` message. CUE constraints live in
[`cue/stage6_notify_separation.cue`](./cue/stage6_notify_separation.cue). The PACT contract in
[`contracts/pacts/stage6-notify-separation.pact.json`](./contracts/pacts/stage6-notify-separation.pact.json)
pins the design-doc validation boundary.

## Parse, Don't Validate

The boundary parser accepts raw stage-6 markdown once and derives a `Stage6LaneSeparationRecord`
parsed domain type. Downstream validation receives that derived type, not broad DTO values.

## Event Architecture

- **Command**: `stage6NotifySeparation.ValidateTables` requests validation of the stage-6 acceptance
  record tables.
- **Event**: `stage6NotifySeparation.TablesValidated` or `stage6NotifySeparation.TablesRejected`
  appends after parsing.
- **Actor**: the intent-alignment drift actor owns the single-writer decision for HOBO-701.
- **Event store**: validation events append to the drift-remediation event store.
- **Materialized view / projection**: `Stage6NotifySeparationView` folds events into the current
  notify-vs-governance separation state.
- **Snapshot**: the latest validated table separation is the projection snapshot for reviewers.
- **Read store**: GAPS.md and stage-6 acceptance readers query the read store instead of re-parsing
  raw markdown ad hoc.
