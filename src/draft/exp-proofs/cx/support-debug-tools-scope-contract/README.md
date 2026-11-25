# Support & Debug Tools Scope POC

HOBO-426 proof for Support & Debug Tools M0 scope and acceptance.

## What This Proves

- Support & Debug Tools has an explicit user/business goal and five primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- Dependencies map to Plan 07, Plan 49, workspace activation telemetry, Admin Console, Audit
  Explorer, Support SLA Channels, Launch Support Escalation, Operators/SRE, Data Plane, ADR-0074,
  ADR-0050, and ADR-0058.
- Owning initiative dependencies are mapped without moving UI implementation, ticketing, live
  diagnostics, remediation, RBAC, or data-plane runtime work into this issue.
- Diagnostic bundle classes, recovery routes, and M1 evidence requirements are listed with owner,
  proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build Support & Debug Tools UI, routes,
support ticket queues, helpdesk integration, live log or trace collection, event-store runtime,
runbook remediation, RBAC enforcement, provider credential access, raw customer-data access, or
downstream implementation issues.

## Verification

```powershell
pnpm --dir src\draft\support-debug-tools-scope-contract test
pnpm --dir src\draft\support-debug-tools-scope-contract typecheck
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Support & Debug Tools Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
