# Environment Lifecycle Scope POC

HOBO-414 proof for Environment Lifecycle M0 scope and acceptance.

## What This Proves

- Environment Lifecycle has an explicit user/business goal and four primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on Settings & Project Lifecycle, organization/workspace ownership,
  developer experience, platform engineering, tenant/security, support, backup/restore, and cleanup records.
- Owning initiative dependencies are mapped without moving settings, admin console, dashboard,
  tenant quota, backup/restore, cleanup, or support workflow implementation into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build an environment service runtime,
provider provisioning, DNS, deployments, admin screens, RBAC enforcement, quota/billing logic,
backup/restore runtime, cleanup sweepers, support tooling, or downstream implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\environment-lifecycle-scope test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Environment Lifecycle Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
