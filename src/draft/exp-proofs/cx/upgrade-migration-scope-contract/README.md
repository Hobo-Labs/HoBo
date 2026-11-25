# Upgrade Migration Scope Contract

This package is the executable M0 proof for HOBO-430. It records the accepted Upgrade & Migration
Engine scope, validates the required persona/scope/boundary/dependency shape, and guards against
implementation creep into production upgrade runners, live migrations, rollback execution, backup
restore, provider state rewrites, compatibility UI, release publication, or support automation.

The authoritative design record is
[`docs/design/upgrade-migration-engine.md`](../../../../../docs/design/upgrade-migration-engine.md).

## Proof

Run the focused proof with:

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\upgrade-migration-scope-contract test
```

The tests prove:

- user/business goal and primary personas are explicit;
- scope in/out, non-goals, and operating boundaries are recorded;
- dependencies map to release notes, compatibility contracts, data migrations, WIT host pins, and
  role walkthrough sources;
- owning initiative boundaries are named without taking adjacent scope;
- M1 evidence requirements are listed with owner, source, proof mode, and claim;
- follow-up M1-M4 issue creation is blocked until M0 acceptance;
- excluded live upgrade runner, migration execution, rollback, backup restore, provider state,
  compatibility UI, release publication, and support automation work is routed out.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- [`proto/upgrade_migration_scope.proto`](./proto/upgrade_migration_scope.proto) — protobuf data shapes for the M0 scope record.
- [`cue/upgrade_migration_scope.cue`](./cue/upgrade_migration_scope.cue) — CUE constraints for every protobuf type.
- [`contracts/pacts/m0-scope-acceptance-gate.pact.json`](./contracts/pacts/m0-scope-acceptance-gate.pact.json) — PACT for the follow-up acceptance-gate boundary.
- [`ADR.md`](./ADR.md) — parse-don't-validate and event-architecture evidence.
