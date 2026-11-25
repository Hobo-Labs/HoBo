# HoBo Token Broker Skeleton POC

This draft pins the HOBO-84 token broker skeleton for `ctx.token(...)` and the
MCP `request_token` path from
[Plan 6](../../../../docs/design/ai-native-agent-auth.md#plan-06) and
[ADR-0008](../../../../docs/design/adr/02-identity-security.md#adr-0008).

## Contract Surface

- Requests carry `{ provider, scope: { port, resource, action } }` plus the
  caller SVID scope and principal.
- The broker denies requests outside the caller SVID scope before manifest
  lookup or flow dispatch.
- Known providers resolve a signed `auth.json` manifest, select the preferred
  flow using the HOBO-48 contract, and dispatch through a pluggable flow seam.
- Stub flows return `stub: true` credentials with a `tokenRef`, expiry, and the
  requested scope echoed back to the caller.
- Successful requests emit validated `token.Granted` and `token.Used` audit
  events using the HOBO-66 identity event contract.
- Unknown providers emit `token.Denied`.
- API-key-only manifests are still executable for legacy providers, but the
  selected flow carries the `last-resort-static-secret` warning.
- The `ctx.token(...)` helper and MCP `request_token` tool both delegate to the
  same `broker.requestToken` path.

## Proof Boundaries

This proof does not implement real OIDC/STS exchange, ID-JAG/XAA exchange,
credential caches, high-availability broker runtime, or pre-mint policy checks.
Those are deliberately out of scope for HOBO-84.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\token-broker-skeleton-contract test
```

The checks prove the fixture `auth.json` flow resolution, scoped stub-token
response, `token.Granted`/`token.Used` emission, unknown-provider denial,
out-of-SVID-scope fail-closed ordering, API-key fallback marking, audit
redaction, `ctx.token(...)`, and MCP `request_token` delegation.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Token Broker Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
