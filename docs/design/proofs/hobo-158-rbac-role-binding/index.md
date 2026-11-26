# HOBO-158 RBAC Role Binding Proof

This proof covers the M2 policy/security slice that consumes Plan 29's
control-plane action taxonomy, ADR-0038's `hobo:auth` port, ADR-0073's
swappable integration-port claims mapping, and ADR-0074's org-governance RBAC
decision.

## Scope

- `src/draft/technical-proofs/rbac-role-binding-contract` defines a pure RBAC role and
  role-binding model over the existing control-plane action taxonomy.
- Built-in roles are represented as named role definitions with concrete grant
  sets; custom roles can compose validated subsets of `hobo:*` action ids.
- Principal bindings and `hobo:auth` SCIM group bindings resolve into
  `subject.roles` for policy decision requests.
- `role:bind` checks fail closed when the binder lacks the target role's grants
  or lacks `hobo:role:bind`.
- The package stays at the pure role/binding boundary; policy-engine default
  matrix integration, genesis, break-glass, and identity issuance remain outside
  this slice.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Six built-in roles exist with grant sets. | `pins the six built-in roles with concrete control-plane grant sets` |
| Custom role composes a subset of the taxonomy. | `lets custom roles compose a validated subset of the action taxonomy` |
| SSO/SCIM group maps to a role and populates `subject.roles`. | `maps SSO/SCIM groups through the auth port into subject.roles` |
| Crew operator principal is RBAC-bound and cannot act outside its role. | `keeps Crew operator agents capped to their bound role during repair loops` |
| `role:bind` by a principal lacking privilege cannot grant it. | `blocks role:bind self-escalation and grants the binder lacks` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Principal binds itself or another principal to grants it lacks. | `blocks role:bind self-escalation and grants the binder lacks` |
| Operator exceeds its capped role during a repair loop. | `keeps Crew operator agents capped to their bound role during repair loops` |
| Stale SCIM group membership leaves a role behind. | `drops stale SCIM groups and denies unbound principals by default` |
| Unbound principal gets accidental allow. | `drops stale SCIM groups and denies unbound principals by default` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\rbac-role-binding-contract test
```
