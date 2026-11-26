# ADR: CLI Migration Transcript Prototype Boundary

Accepted for HOBO-575.

## Context

The V1 vibe migration slice needs terminal-first examples for brownfield and
app-data migration before product docs or visual artifacts can use them. The
proof must stand alone while blockers HOBO-569, HOBO-571, and HOBO-572 are clean
In Review PRs waiting on merge ownership.

## Decision

Model the transcript as a parsed design-proof record instead of a production
CLI runner. Parse, don't validate: this package parses untrusted fixture input
once at the boundary into derived domain types, and downstream consumers receive
the parsed `ParsedCliMigrationTranscriptPrototype` instead of re-checking raw
transcript DTOs. The parser accepts one fixture-shaped object and returns that
derived type only when it contains the required transcript cases, migration
event fixtures, gate blockers, safe next steps, and SDK/API example parity.

The command family is `migration.import`, `migration.plan`, `migration.apply`,
`migration.verify`, `migration.rollback`, `migration.export`,
`migration.importSink`, and `migration.cutOver`. The event family is
`migration.Planned`, `migration.SnapshotTaken`, `migration.PhaseApplied`,
`migration.Verified`, `migration.RolledBack`, `migration.Exported`,
`migration.Imported`, and `migration.CutOver`.

`MigrationTranscriptActor` is the actor that owns commands and appends events
to a fixture event-store stream. `MigrationTranscriptProjection` is the
materialized view / projection that folds those events into a read store
transcript snapshot so docs, quickstarts, support handoff, and future visual
slices consume replayable evidence instead of raw DTOs.

## Consequences

- Gatekeeper, Pact compatibility, and `can-deploy` are visible in the blocked
  destructive contract phase.
- Snapshot restore and cutover have replayable event fixtures.
- SDK and API examples share the same request/result envelope.
- Scope creep into real Terraform import, live databases, automatic
  cross-engine remodelling, irreversible destructive migration, or hand-written
  `.down` claims fails closed in tests.

## Architecture Proof

- Protobuf: `architecture/cli_migration_transcript_prototype.proto`.
- CUE: `architecture/cli_migration_transcript_prototype.cue`.
- Pact: `architecture/pacts/cli_migration_transcript_prototype.pact.json`.
- Test: `test/cli-migration-transcript-prototype.test.ts`.
