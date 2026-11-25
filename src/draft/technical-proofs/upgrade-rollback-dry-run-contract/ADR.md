# Upgrade Rollback Dry-Run Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how dry-run data is parsed and how its records
map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is parsed once at
the dry-run boundary into parsed, derived domain types. Downstream consumers receive the parsed
request and dry-run report instead of raw DTOs plus repeated boolean checks. The parser rejects live
execution intent before it can become a migration, rollback, provider-state, or support-automation
command.

## Event Architecture

The package's dry-run report is the read model behind a small event flow:

- **Command** - a request to evaluate an upgrade dry-run for a declared source/target path.
- **Event** - a successful command appends `upgradeDryRun.Reported`; a rejected execution intent
  appends `upgradeDryRun.Rejected`.
- **Actor** - the Upgrade & Migration dry-run aggregate is the actor that applies events in order.
- **Event store** - dry-run report and rejection events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds the event store into dry-run status,
  blocked-path, rollback-evidence, release-note, and support-handoff views.
- **Snapshot** - each deterministic fixture is a snapshot of the projection at a known source and
  target version pair.
- **Read store** - release notes, support, compatibility, and upgrade-test consumers query the read
  store instead of the raw event log.

No runtime upgrade engine, migration runner, rollback executor, projector, or event store is
implemented here; this is a design-time contract that names command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
