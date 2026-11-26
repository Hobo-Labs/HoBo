# HOBO-233 Inbound XAA Resource Server Proof

Refs:

- [PLAN-06](../../ai-native-agent-auth.md#plan-06)
- [ADR-0084](../../adr/02-identity-security.md#adr-0084)

Package:

- `src/draft/technical-proofs/inbound-xaa-resource-server-contract`

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\inbound-xaa-resource-server-contract test
```

Acceptance mapping:

- ID-JAG verification is proven by signing with a fixture external IdP and verifying the compact assertion against the trusted JWKS.
- Audience/resource binding is proven by rejecting assertions addressed to another HoBo app or resource.
- Issuer trust is proven by rejecting an assertion from an issuer absent from the trusted issuer map.
- JWKS signature verification is proven by rejecting a tampered compact assertion before token issuance.
- Delegation mapping is proven by asserting `subject.delegatedBy` becomes `ctx.user` and the requesting agent remains `ctx.identity`.
- Scoped token behavior is proven by returning only a `vault://tokens/inbound-xaa/...` reference with the requested scopes and ID-JAG-bounded expiry.
- MCP inbound support is proven by the bridge dispatching a tool only after inbound XAA acceptance.

Adversarial mapping:

- Wrong-audience assertions fail closed before a credential is returned.
- Expired assertions fail closed.
- Nonce replay fails closed with the shared consumed-nonce set.
- Missing delegated user is denied by the ID-JAG parser.
- Policy denial and policy-store failure emit `token.Denied` and return no credential.

Scope boundary:

- The package does not mint outbound ID-JAGs, implement the policy `.allow()` engine, define connector authoring, or complete the full confused-deputy hardening matrix.
