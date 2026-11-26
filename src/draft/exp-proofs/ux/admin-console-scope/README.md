# Admin Console Scope POC

HOBO-425 proof for Admin Console M0 scope and acceptance.

## What This Proves

- Admin Console has an explicit user/business goal and four primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- Dependencies map to Plan 07, organization/workspace, settings/project lifecycle, Member/RBAC,
  tenant isolation/quotas, support SLA, Plan 50, ADR-0074, ADR-0077, and ADR-0080.
- Owning initiative dependencies are mapped without moving UI implementation, RBAC, quota,
  support workflow, security verification, or broker runtime work into this issue.
- Read-model classes, action-intent categories, and M1 evidence requirements are listed with
  owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build Admin Console UI, routes, service
runtime, RBAC enforcement, tenant quotas, billing, support ticket workflows, incident publishing,
provider credential access, live customer-data mutation, broker runtime, or downstream
implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\admin-console-scope test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Admin Console Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
