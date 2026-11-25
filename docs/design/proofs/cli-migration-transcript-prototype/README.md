---
type: Reference
title: "CLI Migration Transcript Prototype Proof"
description: "Source issue: HOBO-575."
tags: [hobo, design]
---

# HOBO-575 CLI Migration Transcript Prototype Proof

Source issue: HOBO-575.

Package:
[`src/draft/exp-proofs/dx/cli-migration-transcript-prototype`](../../../../src/draft/exp-proofs/dx/cli-migration-transcript-prototype/README.md).

## Proven Acceptance

| Acceptance | Executable evidence |
|---|---|
| Transcript covers adopt-in-place, still-external resources, safe additive migration, blocked destructive contract, snapshot restore, and cross-cloud export/import/cutover. | `REQUIRED_TRANSCRIPT_CASES` and the transcript acceptance test assert all six cases in order. |
| Uses the required `migration.*` fixtures. | `REQUIRED_MIGRATION_EVENTS` pins plan, snapshot, expand/backfill/contract phase application, verification, rollback, export, import, and cutover fixtures. |
| Shows Gatekeeper, Pact compatibility, and `can-deploy` blocking breaking schema changes with safe next steps. | The blocked contract test asserts all three blockers and the safe next-step list. |
| Includes SDK/API examples for the same request and result envelope. | `assertMigrationExampleParity` checks matching SDK/API request and envelope payloads. |

## Scope Guard

Tests reject real Terraform import, live databases, automatic cross-engine
remodelling, irreversible destructive migrations, and hand-written `.down`
migration claims.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cli-migration-transcript-prototype test
```

## Architecture Guard Notes

The package includes local protobuf, CUE, and Pact artifacts so future docs,
quickstarts, visual slices, and support handoff work consume one replayable
transcript contract instead of raw transcript text. Its package ADR records the
parse-once boundary into derived domain types plus the command, event-store,
projection, snapshot, and read-store behavior.
