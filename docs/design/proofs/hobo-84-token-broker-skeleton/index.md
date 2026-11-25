# HOBO-84 Token Broker Skeleton Proof

This executable proof pins the M1 token broker skeleton from
[Plan 6](../../ai-native-agent-auth.md#plan-06) and
[ADR-0008](../../adr/02-identity-security.md#adr-0008). It composes the
HOBO-48 `auth.json` contract with the HOBO-66 identity audit event contract.

## Contract Surface

- `request_token` and `ctx.token(...)` share one broker request path shaped as
  `{ provider, scope: { port, resource, action } }`.
- Broker requests are checked against the caller SVID scope before any manifest
  lookup or flow exchange seam.
- Provider manifests resolve through signed fixture `auth.json` envelopes and
  deterministic keyless-first flow selection.
- Flow handlers are pluggable stubs and mark issued credentials as fake
  credentials through `stub: true` and a non-secret `tokenRef`.
- Successful requests emit `token.Granted` and `token.Used`.
- Denied provider or scope requests emit `token.Denied`.
- Static API-key fallback remains marked `last-resort-static-secret`.
- Audit events never carry plaintext token values.

## Proof Boundaries

The proof stops at the skeleton seam. It does not implement live STS/OIDC
exchange, ID-JAG/XAA exchange, credential cache HA, or the future pre-mint
deny-by-default policy hook.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\token-broker-skeleton-contract test
```

The checks live in
`src/draft/technical-proofs/token-broker-skeleton-contract/test/token-broker-skeleton.test.ts`
and include both `ctx.token(...)` and MCP `request_token` delegation.
