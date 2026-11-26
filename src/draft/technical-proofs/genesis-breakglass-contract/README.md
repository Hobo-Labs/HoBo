# Genesis Break-Glass Contract POC

This draft pins the HOBO-166 and HOBO-279 contracts for the first Yard
`Org-Admin` bootstrap and the emergency recovery path when normal identity and
policy-control paths are unavailable.

It defines:

- A one-time `identity.GenesisAdmin` fact with an immediate `role.BindingCreated`.
- A genesis-authorized first real role binding that resolves the bootstrap
  chicken-and-egg before normal RBAC/SCIM paths are available.
- A rotation path that revokes the bootstrap admin and binds the durable admin.
- A `hobo doctor`-style diagnostic for an unrotated genesis admin.
- Offline Ed25519 break-glass credentials that produce auditable policy and
  identity events.
- Emergency-context gating: a valid offline credential is denied unless the IdP
  is unavailable and a mandatory policy rule is blocking all changes.
- Replay protection for break-glass nonces.
- Guardrails proving normal IdP tokens and self-granted `Org-Admin` bindings
  cannot recover a bricked mandatory rule.

## Proof Boundaries

This is a contract POC. It does not implement the RBAC engine, KMS custody,
policy-pack storage, IdP integration, mandatory-rule algebra, waiver approvals,
or runtime provider wiring.

## Verification

Run the focused contract suite:

```powershell
npm.cmd --prefix src\draft\technical-proofs\genesis-breakglass-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Genesis Breakglass Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
