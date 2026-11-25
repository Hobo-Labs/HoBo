# Inbound XAA Resource Server Contract

HOBO-233 proof package for treating HoBo apps as Cross-App Access (XAA) resource servers.

The package models the inbound side of [PLAN-06](../../../../docs/design/ai-native-agent-auth.md#plan-06)
and [ADR-0084](../../../../docs/design/adr/02-identity-security.md#adr-0084):

- accepts a compact ID-JAG assertion for a HoBo app audience and resource;
- verifies the assertion signature against a configured trusted issuer JWKS;
- rejects wrong issuer, wrong audience, wrong resource, bad signatures, expiration, replay, and missing delegation;
- maps `subject.delegatedBy` into `ctx.user` for downstream `.allow()` evaluation;
- issues only a short-lived token reference scoped to the inbound request; and
- lets an MCP call run under the delegated external-agent principal.

Out of scope: outbound ID-JAG minting, the `.allow()` policy engine implementation, connector authoring, and full confused-deputy hardening. Those remain with the referenced follow-on issues.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\inbound-xaa-resource-server-contract test
```

Covered behaviors:

- trusted fixture IdP JWKS verifies the inbound ID-JAG and yields a scoped HoBo token reference;
- delegated user surfaces as `ctx.user`, while `ctx.identity` remains the requesting external agent;
- wrong audience, wrong resource, bad signature, and untrusted issuer fail closed;
- expired, replayed, and no-delegated-user assertions fail closed;
- policy denial or policy-store failure emits `token.Denied` without returning a credential; and
- `@hobo/mcp` accepts inbound XAA before dispatching a tool as the delegated external agent.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Inbound Xaa Resource Server Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
