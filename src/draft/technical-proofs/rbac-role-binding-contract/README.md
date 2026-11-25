# RBAC Role Binding Contract

This draft package proves the HOBO-158 RBAC model as a pure contract slice.
It consumes the existing control-plane action taxonomy and PrincipalRef role
constants, then resolves direct and SCIM-backed role bindings into
`subject.roles`.

The package intentionally stops at the role/binding boundary. It does not issue
identities, seed genesis or break-glass users, or integrate the default role
matrix into the policy engine; those remain separate slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\rbac-role-binding-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Rbac Role Binding Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
