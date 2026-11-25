# HOBO-54 ID-JAG Token-Exchange Contract

This independent POC pins the outbound Cross-App Access token-exchange wire contract from
[Plan 6](../../../../docs/design/ai-native-agent-auth.md#plan-06) and
[ADR-0084](../../../../docs/design/adr/02-identity-security.md#adr-0084).

## Contract Surface

- Stage 1 uses OAuth Token Exchange with
  `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`.
- Stage 1 responses carry the ID-JAG in `access_token` with `token_type=N_A`, matching
  the current draft's historical response field.
- Stage 2 redeems that assertion with the JWT bearer grant.
- The draft pin is `draft-ietf-oauth-identity-assertion-authz-grant-04`, shared with
  the HOBO-48 `auth.json` contract.
- HoBo requires `subject.delegatedBy.kind=user` so anonymous delegation is fail-closed.
- Audience, resource, expiry, scope, and nonce replay checks are enforced by the parser.

## Scope Boundary

This package does not mint production ID-JAGs, call a live OAuth server, verify JWKS
signatures, run policy decisions, implement `connector()`, or implement inbound HoBo
resource-server verification. It is the wire-contract proof only.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\id-jag-token-exchange-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Id Jag Token Exchange Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
