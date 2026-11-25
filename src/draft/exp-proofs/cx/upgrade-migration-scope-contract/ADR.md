# Upgrade & Migration Engine M0 Scope — Architecture Evidence

This package is the HOBO-430 design-time scope contract. It carries the
architecture evidence required by `scripts/check-architecture-guardrails.mjs`
so the contract states, rather than implies, how its data shapes are parsed and
how an accepted scope record participates in the platform's event flow.

## Schema And Constraints

- Protobuf data shapes for the scope record live in
  [`proto/upgrade_migration_scope.proto`](./proto/upgrade_migration_scope.proto).
- CUE constraints for every protobuf type live in
  [`cue/upgrade_migration_scope.cue`](./cue/upgrade_migration_scope.cue).

## Parse, Don't Validate

`validateUpgradeMigrationScope` in
[`src/upgrade-migration-scope.mjs`](./src/upgrade-migration-scope.mjs) applies the
**parse, don't validate** discipline: an untrusted scope object is parsed once at
the boundary into derived domain types — an accepted `UpgradeMigrationScope`, its
`UpgradePathClass` list, and its `FollowUpGate` — and every later consumer
receives those parsed, derived types instead of re-checking raw input. The CUE
constraints bound the same derived types so a malformed scope record is rejected
at parse time, not silently passed downstream.

## Event Architecture

The accepted scope record is the read model behind a small event flow that the
follow-up gate and traceability surfaces consume:

- **Command** — `RecordUpgradeMigrationM0Scope` requests acceptance of the
  HOBO-430 scope record.
- **Event** — a successful command appends the `UpgradeMigrationM0ScopeAccepted`
  domain event; follow-up M1–M4 events are only valid after it.
- **Actor** — the Upgrade & Migration scope aggregate is the actor that owns
  acceptance and rejects out-of-order acceptance events.
- **Event store** — accepted scope and follow-up events are appended to the
  platform event store as the durable source of truth.
- **Materialized view / projection** — a projection folds the event store into
  the accepted-scope read model used by `canCreateUpgradeMigrationFollowUp`.
- **Snapshot** — the accepted scope record is the snapshot of that projection at
  M0 acceptance, so the follow-up gate can answer without replaying history.
- **Read store** — the traceability and follow-up surfaces query that read store
  (the snapshot) rather than the raw event log.

No runtime upgrade engine, migration runner, projector, or event store is
implemented here; this record only names the command, event, actor, and
projection boundaries so M1+ implementation work inherits a consistent
vocabulary.
