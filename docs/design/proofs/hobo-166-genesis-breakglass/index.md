# HOBO-166 Genesis Break-Glass Proof

This proof pins the M2 governance/security slice for the one-time Yard
`Org-Admin` bootstrap and offline-signed break-glass recovery described by
[Plan 29](../../contracts-policy-flags.md#plan-29) and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

## Acceptance Evidence

- `seedGenesisAdmin()` emits one auditable `identity.GenesisAdmin` fact and one
  immediate role-binding creation event for the first Yard `Org-Admin`.
- Genesis replay returns `GENESIS_ALREADY_CONSUMED` and does not mint a second
  `Org-Admin`.
- `rotateGenesisAdmin()` revokes the bootstrap binding, creates the durable
  admin binding, and records `identity.GenesisAdminRotated`.
- Offline Ed25519 break-glass recovery emits `policy.Decided` and
  `identity.BreakGlassUsed` only when the IdP is unavailable and a mandatory
  policy rule is bricking all changes.
- A valid offline credential outside that emergency context is denied with
  `BREAK_GLASS_CONTEXT_NOT_BRICKED`.
- Normal IdP-path recovery, self-grant escalation, tampered credentials, and
  nonce replay all fail closed.

## Scope Guard

This contract POC does not implement RBAC, the waiver path, identity issuance
internals, KMS custody, policy-pack storage, IdP integration, or runtime/provider
wiring. It only proves the emergency bootstrap and break-glass decision surface.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\genesis-breakglass-contract test
npm.cmd test
```
