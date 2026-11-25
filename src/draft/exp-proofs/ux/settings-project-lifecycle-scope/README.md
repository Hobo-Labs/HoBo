# Settings & Project Lifecycle Scope POC

HOBO-412 proof for Settings & Project Lifecycle M0 scope and acceptance.

## What This Proves

- Settings & Project Lifecycle has an explicit user/business goal and four primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on Plan 07, Plan 10, Plan 50, ADR-0077, and ADR-0074.
- Owning initiative dependencies are mapped without moving RBAC, tenant quotas, environment
  lifecycle, dashboard, or support workflow implementation into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build an admin console, RBAC enforcement,
tenant quota metering, environment lifecycle runtime, support desk, live provider provisioning, or
downstream implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\settings-project-lifecycle-scope test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Settings Project Lifecycle Scope.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
