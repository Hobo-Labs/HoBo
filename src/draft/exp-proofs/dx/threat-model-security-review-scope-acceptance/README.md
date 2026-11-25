# Threat Model & Security Review Scope Acceptance

Executable M0 productization contract for HOBO-451.

This package records the accepted scope boundary for the Threat Model & Security
Review project before M1 design or implementation issues fan out. It is
intentionally not a live scanner, SAST/DAST integration, SIEM integration,
exploit runner, incident service, support queue, legal/advisory copy source, or
release gate bypass.

## What It Proves

- User/business goal and primary personas are explicit.
- Scope in, scope out, and non-goals are machine-checkable.
- Service, UX, security, and support boundaries are mapped.
- Owning initiative dependencies are mapped to Security Verification, release
  cutline, launch support, incident communications, and legal/privacy signoff.
- Threat-review intake fields and beta/RC/GA review gates are listed before
  follow-up work can start.
- Follow-up M1-M4 work is blocked until M0 scope acceptance is recorded.
- Scope creep into scanners, exploit runners, gate bypasses, or legal/advisory
  copy is rejected.

## Architecture Evidence

- `ARCHITECTURE.md` records the parse, don't validate boundary, derived domain
  types, commands, events, actor, event-store, materialized view/projection,
  snapshot, and read store.
- `contracts/pacts/threat-model-security-review-scope.pact.json` records the
  boundary between Security Verification and this scope record.
- `proto/threat_model_security_review_scope.proto` and
  `cue/threat_model_security_review_scope.cue` pin the M0 data shapes and
  constraints.

## Verification

Run the focused proof:

```powershell
pnpm.cmd --dir src\draft\exp-proofs\threat-model-security-review-scope-acceptance test
```

Run the base-aware architecture guard used by CI:

```powershell
pnpm.cmd run architecture:guard -- --base=origin/main
```

The proof is referenced by the design record:

- [Threat Model & Security Review design record](../../../../../docs/design/threat-model-security-review.md)
- [HOBO-451 proof record](../../../../../docs/design/proofs/hobo-451-threat-model-security-review/README.md)
