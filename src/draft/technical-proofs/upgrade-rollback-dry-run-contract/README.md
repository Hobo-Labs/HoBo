# Upgrade Rollback Dry-Run Contract

HOBO-499 proof for the Upgrade & Migration Engine M1 dry-run contract.

## What This Proves

- The dry-run report covers preflight status, compatibility input, backup requirement, migration
  plan output, rollback evidence, unsupported path reporting, release-note inputs, and support
  handoff.
- Deterministic fixtures cover clean upgrade, blocked upgrade, failed migration, and rollback-ready
  paths.
- Unsupported and failed paths produce customer-safe release/support evidence without producing
  mutation commands.
- Live migration, rollback executor, provider-state rewrite, and support automation requests are
  rejected at the parser boundary.

## Boundary

This package is a non-mutating contract proof. It does not implement a production upgrade runner,
live migration engine, rollback executor, backup restore, provider/IaC state mutation, release-note
publication, or support ticket automation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\upgrade-rollback-dry-run-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the dry-run request/report.
- `architecture/pacts/` - PACT contract for the dry-run boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
