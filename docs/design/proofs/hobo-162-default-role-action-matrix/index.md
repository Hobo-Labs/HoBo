# HOBO-162 Default Role Action Matrix Proof

This proof makes the Plan 29 default role/action matrix and SoD obligations
executable in
[`src/draft/exp-proofs/dx/default-role-action-matrix-contract`](../../../../src/draft/exp-proofs/dx/default-role-action-matrix-contract/README.md).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Each built-in role resolves to exactly its matrix grant set | `resolves every built-in role to its Plan 29 grant set` |
| Policy-pack author cannot self-approve | `blocks policy-pack self-approval and requires Security Policy Admin approval` |
| Delta opener cannot promote that Delta to prod | `blocks the Delta opener from promoting that Delta to prod` |
| Prod `delta:promote` requires an approval obligation while lower env promote is free | `requires prod delta promotion approval while allowing lower-environment promotion` |
| Two-person approval blocks Org-Admin self-approval | `enforces two-person approval even for Org Admin policy changes` |
| Auditor never gets write or promote grants | `denies unlisted grants and prevents Auditor writes or promotion` |
| `role:bind` cannot grant privileges the binder lacks | `prevents role:bind self-escalation beyond the binder grant set` |
| Operator-Supervisor `forge:execute` is the capped Crew-operator path | `keeps Operator Supervisor forge execution capped to Crew operator principals` |

## Boundary

This is only the default matrix and SoD contract. The role model, SSO/SCIM
binding, durable obligation execution, genesis admin seeding, and break-glass
path remain owned by their separate Linear slices.

## Verification

```sh
npm.cmd --prefix src/draft/exp-proofs/dx/default-role-action-matrix-contract test
```
