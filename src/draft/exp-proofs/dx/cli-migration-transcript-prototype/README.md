# CLI Migration Transcript Prototype

HOBO-575 proof for the terminal-first migration transcript that later docs,
visuals, quickstarts, and support examples can consume without inventing
migration behavior.

## What This Proves

- `hobo import terraform` is shown as adopt-in-place transcript evidence, not a
  real Terraform import runner.
- Authoritative-external and still-external resources stay explicit in the plan.
- Safe additive migration applies expand and backfill after a snapshot.
- A destructive contract phase is blocked by Gatekeeper, Pact compatibility, and
  `can-deploy`, with safe next steps instead of an irreversible migration claim.
- Snapshot restore, cross-cloud export/import, and cutover use the required
  `migration.*` event fixtures.
- SDK and API examples share the same migration request and result envelope.

## Transcript Cases

| Case | Command shape | Evidence |
|---|---|---|
| adopt-in-place | `hobo import terraform ./brownfield/billing-db.tfstate --adopt --json` | `resource.Adopted` plus authoritative-external debt. |
| still-external | `hobo plan --migration billing-db --show-external --json` | Still-external resource remains outside cutover ownership. |
| safe-additive-migration | `hobo up --migration billing-db --phase expand --phase backfill --json` | Snapshot, expand, backfill, and verification fixtures. |
| blocked-destructive-contract | `hobo up --migration billing-db --phase contract --json` | Gatekeeper/Pact/`can-deploy` block with safe next steps. |
| snapshot-restore | `hobo up --migration billing-db --rollback --to snapshot/hobo-575-pre-backfill --json` | Rollback fixture and replay expectation. |
| cross-cloud-export-import-cutover | `hobo up --migration billing-db --export azure --import aws --cutover-window approved-window --json` | Export, import, verification, and cutover transcript evidence. |

## Required Events

The executable proof pins `migration.Planned`, `migration.SnapshotTaken`,
`migration.PhaseApplied` for expand/backfill/contract, `migration.Verified`,
`migration.RolledBack`, `migration.Exported`, `migration.Imported`, and
`migration.CutOver` fixtures.

## Scope

In scope: transcript data, fixture envelopes, gate outcomes, SDK/API parity, and
scope guards.

Out of scope: real Terraform import, live databases, automatic cross-engine
remodelling, irreversible destructive migrations, and hand-written `.down`
migration claims.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cli-migration-transcript-prototype test
```

## Architecture Evidence

- `architecture/cli_migration_transcript_prototype.proto` defines the proof
  messages and fixture envelopes.
- `architecture/cli_migration_transcript_prototype.cue` constrains transcript
  cases, events, phases, and gate behavior.
- `architecture/pacts/cli_migration_transcript_prototype.pact.json` records the
  design-proof registry consumer contract.
- `ADR.md` names the command, event, actor, projection, replay, and snapshot
  contracts that keep this POC independent from production migration runtime.
- Parse, don't validate: fixture input parses once into
  derived domain types, then event-store, materialized view / projection,
  snapshot, and read store behavior are documented for downstream consumers.
