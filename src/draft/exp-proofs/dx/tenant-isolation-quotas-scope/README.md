# Tenant Isolation & Quotas Scope

Executable M0 productization contract for HOBO-415.

This draft package records the accepted scope boundary for Tenant Isolation & Quotas before M1
design or implementation issues fan out. It is intentionally not a runtime tenant isolation engine,
quota enforcer, RBAC surface, provider integration, or billing system.

## What It Proves

- The user/business goal and primary personas are explicit.
- Scope in, scope out, and non-goals are machine-checkable.
- Platform tenant, project, app tenant, and end-user axes stay distinct.
- Service, UX, security, and support ownership boundaries are named.
- Owning initiative dependencies are mapped to the nearest downstream owner.
- M1 evidence is listed before follow-up implementation issues can be created.
- Scope creep into billing, runtime enforcement, RBAC, tenant admin UI, provider work, or live
  customer data is rejected.

## Verification

Run the focused proof:

```powershell
npm.cmd --prefix src\draft\exp-proofs\tenant-isolation-quotas-scope test
```

The proof is also referenced by the design record:

- [Tenant Isolation & Quotas design record](../../../../../docs/design/tenant-isolation-quotas.md)
- [HOBO-415 proof record](../../../../../docs/design/proofs/hobo-415-tenant-isolation-quotas/README.md)


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tenant Isolation Quotas Scope.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
