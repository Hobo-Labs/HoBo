# Secret-Zero Genesis Bootstrap Contract

HOBO-262 adversarial proof for the identity genesis bootstrap trust chain from
[Plan 06](urn:hobo:requirement:ai-native-agent-auth#plan-06),
[Plan 12](urn:hobo:requirement:security-networking#plan-12),
[ADR-0008](urn:hobo:decision:adr-0008),
and [ADR-0074](urn:hobo:decision:adr-0074).

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


## Executable evidence
This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Secret Zero Genesis Bootstrap Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
