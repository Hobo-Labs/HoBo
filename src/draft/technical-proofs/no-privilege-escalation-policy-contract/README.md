# No Privilege Escalation Policy Contract

This draft pins the HOBO-209 adversarial proof for Plan 29, ADR-0074,
ADR-0080, and ADR-0096. It composes existing proof slices instead of creating a
new runtime policy engine:

- `deny-ceiling-algebra-poc` for mandatory deny-ceiling composition.
- `rbac-role-binding-contract` for `role:bind` no-self-escalation.
- `hobo-principal-ref-contract` for resolved vs unresolved `ctx.tenant`.
- `genesis-breakglass-contract` for the one-time genesis bootstrap fact.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Child pack un-denying a parent mandatory deny is rejected. | `child pack un-denying a parent mandatory deny is rejected at compose time` |
| Binder cannot grant privilege it lacks. | `role:bind cannot grant privileges the binder lacks, even through chained binds` |
| Crew operator cannot exceed its capped role. | `Crew operator repair loop cannot accumulate privileges beyond its capped role` |
| Unresolved `ctx.tenant` fails closed, never all-tenants/admin. | `unresolved ctx.tenant fails closed instead of becoming cross-tenant-admin` |
| Genesis bootstrap is the only escalation and one-time. | `genesis bootstrap is the only escalation path and it is one-time` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Federated child mandatory pack widens by ordering trick. | `federated mandatory ordering tricks cannot widen a parent deny-ceiling` |
| Binder chains two binds to grant past its own grants. | `role:bind cannot grant privileges the binder lacks, even through chained binds` |
| Dropped-tenant bug becomes cross-tenant-admin. | `unresolved ctx.tenant fails closed instead of becoming cross-tenant-admin` |
| Repair-loop operator accumulates privilege beyond cap. | `Crew operator repair loop cannot accumulate privileges beyond its capped role` |

## Scope Guard

This package is a contract proof. It does not implement policy pack federation,
the full RBAC engine, cross-tenant data enforcement internals, Crew runtime
internals, or provider-backed policy evaluation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\no-privilege-escalation-policy-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for No Privilege Escalation Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
