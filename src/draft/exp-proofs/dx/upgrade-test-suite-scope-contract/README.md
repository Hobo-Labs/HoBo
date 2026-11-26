# Upgrade Test Suite Scope POC

HOBO-433 proof for Upgrade Test Suite M0 scope and acceptance.

## What This Proves

- Upgrade Test Suite has an explicit user/business goal and five primary personas.
- Scenario classes, required evidence fields, result states, and service/UX/security/support
  boundaries are machine-checkable.
- The scope record depends on Upgrade & Migration Engine, Compatibility Matrix, Backup & Restore,
  Bootstrap Installer, Release Notes, Security Verification, and Support Workflow records without
  taking their implementation scope.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build a production upgrade test runner,
live migration engine, rollback executor, compatibility UI, release approval workflow, support
automation, or any live customer-data or secret-handling behavior.

## Verification

```powershell
corepack pnpm --prefix src\draft\exp-proofs\upgrade-test-suite-scope-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Upgrade Test Suite scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
