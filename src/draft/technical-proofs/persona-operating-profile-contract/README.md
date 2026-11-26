# Persona Operating Profile Contract

HOBO-507 defines the M0 contract for a compact v1 persona operating profile and
recommendation memory boundary.

## What This Proves

- Required profile fields cover industry, team type, approved and blocked systems, risk posture,
  approval owner, cost cap, safe-test depth, existing workflows, primary outcomes, and explicit
  do-not-do boundaries.
- Every field maps to personas, onboarding defaults, safe-test packs, approval defaults, cost caps,
  workspace settings, and first-run telemetry.
- Privacy rules cover purpose minimization, retention, edit/delete, export redaction, and tenant
  boundaries.
- Recommendation memory is v1-bounded to tenant-workspace profile facts and derived decisions,
  preserving QUI-91 as source evidence without copying its implementation backlog.

## Boundary

This package validates the M0 contract only. It does not build product UI, broad profile storage,
ML personalization, behavioral tracking, cross-tenant recommendation memory, CRM, or
customer-success lifecycle tooling.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\persona-operating-profile-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Persona Operating Profile Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
