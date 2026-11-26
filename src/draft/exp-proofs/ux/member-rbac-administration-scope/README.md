# Member/RBAC Administration Scope POC

HOBO-416 proof for Member/RBAC Administration M0 scope and acceptance.

## What This Proves

- Member/RBAC Administration has an explicit user/business goal and four primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- Dependencies map to Organization & Workspace Model, Settings & Project Lifecycle, Tenant
  Isolation & Quotas, Plan 07, Plan 12, ADR-0074, and ADR-0077.
- Owning initiative dependencies are mapped without moving RBAC enforcement, SSO/SCIM sync, tenant
  quotas, security verification, or support workflow implementation into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build RBAC enforcement, policy evaluation,
SSO/SCIM synchronization, admin-console screens, tenant quota enforcement, billing, provider access,
support ticketing, live memberships, or downstream implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\member-rbac-administration-scope test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Member Rbac Administration Scope.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
