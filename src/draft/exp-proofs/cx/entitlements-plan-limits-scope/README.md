# Entitlements & Plan Limits Scope

Executable M0 productization contract for HOBO-419.

This draft package records the accepted scope boundary for Entitlements & Plan Limits before M1
design or implementation issues fan out. It is intentionally not a billing engine, runtime quota
enforcer, RBAC surface, provider-quota integration, fraud/abuse workflow, or customer plan
administration UI.

## What It Proves

- The user/business goal and primary personas are explicit.
- Scope in, scope out, and non-goals are machine-checkable.
- Plan tiers, limit types, and entitlement decision states are declared.
- Service, UX, security, and support ownership boundaries are named.
- Owning initiative dependencies are mapped to the nearest downstream owner.
- M1 evidence is listed before follow-up implementation issues can be created.
- Scope creep into billing, runtime enforcement, RBAC, provider sync, fraud/abuse response, or live
  customer mutation is rejected.

## Verification

Run the focused proof:

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\entitlements-plan-limits-scope test
```

The proof is also referenced by the design record:

- [Entitlements & Plan Limits design record](../../../../../docs/design/entitlements-plan-limits.md)
- [HOBO-419 proof record](../../../../../docs/design/proofs/hobo-419-entitlements-plan-limits/README.md)


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Entitlements Plan Limits Scope.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
