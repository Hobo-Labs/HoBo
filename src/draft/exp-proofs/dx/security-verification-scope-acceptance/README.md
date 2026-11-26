# Security Verification Scope Acceptance

Executable M0 productization contract for HOBO-441.

This package records the accepted scope boundary for the Security Verification
project before M1 design or implementation issues fan out. It is intentionally
not a live scanner, SIEM integration, ticketing workflow, incident service,
customer-notification service, public security page, legal approval, external
bug bounty, CVE workflow, or runtime security engine.

## What It Proves

- The user/business goal and primary personas are explicit.
- Scope in, scope out, and non-goals are machine-checkable.
- Service, UX, security, and support boundaries are mapped.
- Owning initiative dependencies are mapped to release cutline, threat review,
  support escalation, incident communications, and legal/privacy signoff.
- M1 evidence is listed before follow-up security-verification work can start.
- Follow-up M1-M4 work is blocked until M0 scope acceptance is recorded.
- Scope creep into live security services, bug bounty commitments, ticketing
  workflows, legal/advisory text, or proofless public claims is rejected.

## Architecture Evidence

- `ADR.md` records the parse, don't validate boundary, derived domain
  types, commands, events, actor, event-store, materialized view/projection,
  snapshot, and read store.
- `contracts/pacts/security-verification-scope.pact.json` records the PACT
  boundary for release cutline consumption.
- `proto/security_verification_scope.proto` and
  `cue/security_verification_scope.cue` pin the M0 data shapes and constraints.

## Verification

Run the focused proof:

```powershell
pnpm.exe --prefix src\draft\exp-proofs\security-verification-scope-acceptance test
```

Run the base-aware architecture guard used by CI:

```powershell
pnpm.exe run architecture:guard -- --base=origin/main
```

The proof is also referenced by the design record:

- [Security Verification design record](../../../../../docs/design/security-verification.md)
- [HOBO-441 proof record](../../../../../docs/design/proofs/hobo-441-security-verification/README.md)
