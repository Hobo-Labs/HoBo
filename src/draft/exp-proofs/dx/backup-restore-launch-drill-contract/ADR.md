# Backup Restore Launch Drill - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how drill evidence is parsed and how the
record maps onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

The package applies parse-don't-validate discipline: unknown drill input is parsed once at the
contract boundary into derived parsed domain types. Downstream consumers receive the parsed
backup/restore launch drill record instead of re-checking raw DTO fields. The CUE constraints bound
the same derived types so malformed data set, restore path, evidence-output, failure-mode, or gap
routing records are rejected before the drill contract can be consumed.

## Event Architecture

The accepted record is the read model behind a small event flow:

- Command - a request to record or amend the HOBO-498 launch drill contract.
- Event - a successful command appends a `backupRestore.drillContractRecorded` fact to the log.
- Actor - the Backup & Restore evidence aggregate applies drill-contract events in order.
- Event store - accepted drill-contract events are appended as the durable source of truth.
- Materialized view / projection - a projection folds events into the queryable launch drill
  contract.
- Snapshot - the accepted HOBO-498 record is the snapshot of that projection.
- Read store - launch support, compliance, installation, and release-note owners query the read
  store rather than raw event logs.

No runtime restore engine, production backup storage, scheduler, support queue, compliance approval
workflow, or customer recovery service is implemented here.
