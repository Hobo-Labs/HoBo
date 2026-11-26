# Provenance & Retention Scope POC

HOBO-447 proof for Provenance & Retention M0 scope and acceptance.

## What This Proves

- Provenance & Retention has an explicit user/business goal and five primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on Plan 46, Plan 25, Plan 29, ADR-0062, ADR-0073, ADR-0046, and
  ADR-0023.
- Owning initiative dependencies are mapped without moving release channels, compatibility, upgrade,
  backup/restore, approval, audit, or support tooling implementation into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build an artifact store, signing-key system,
SLSA signer, KMS integration, live registry crawler, package scanner, legal retention program,
customer assurance publication workflow, or downstream implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\provenance-retention-scope-acceptance test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provenance Retention Scope Acceptance.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
