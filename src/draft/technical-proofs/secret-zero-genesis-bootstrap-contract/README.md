# Secret-Zero Genesis Bootstrap Contract

HOBO-262 adversarial proof for the identity genesis bootstrap trust chain from
[Plan 06](../../../../docs/design/ai-native-agent-auth.md#plan-06),
[Plan 12](../../../../docs/design/security-networking.md#plan-12),
[ADR-0008](../../../../docs/design/adr/02-identity-security.md#adr-0008),
and [ADR-0074](../../../../docs/design/adr/02-identity-security.md#adr-0074).

## Contract Surface

- Durable SVID/OIDC root generation is represented only by a target-KMS custody event.
- The issuer URL and discovery fingerprint are pinned before provider federation.
- Seed credentials are delegated, not durable roots, and are destroyed before handoff completes.
- Self-deploy preserves the issuer URL and root key instead of rotating trust out from under providers.
- Rogue discovery publication, duplicate issuer instances, post-handoff seed signing, and root material leaks fail closed.

## Scope Guard

This proof stays at the bootstrap trace contract. It does not implement an OIDC server, KMS adapter
internals, provider federation plumbing, genesis Org-Admin policy, break-glass recovery, or
cross-Yard Junction federation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\secret-zero-genesis-bootstrap-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Secret Zero Genesis Bootstrap Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
