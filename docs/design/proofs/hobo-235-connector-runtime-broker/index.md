# HOBO-235 Connector Runtime Broker Proof

Refs:

- [PLAN-06](../../ai-native-agent-auth.md#plan-06)
- [PLAN-21](../../authoring-resources-wiring.md#plan-21)
- [ADR-0084](../../adr/02-identity-security.md#adr-0084)

Package:

- `src/draft/technical-proofs/connector-runtime-broker-contract`

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\connector-runtime-broker-contract test
```

Acceptance mapping:

- Fixture inferred scope `tasks:write` brokers an outbound XAA token scoped exactly to
  `tasks:write` for `ctx.user`: `raw token defaults to the inferred scope and brokers XAA for
  ctx.user`.
- Raw `.token()` defaults to the inferred manifest set: `raw token defaults to the inferred scope
  and brokers XAA for ctx.user`.
- Passing a broader explicit token scope is rejected: `raw token rejects a broader explicit scope
  than the inferred manifest set`.
- A scope the code never exercises is never requested: `raw token defaults to the inferred scope and
  brokers XAA for ctx.user` asserts `tasks:read` is absent.

Adversarial mapping:

- Raw `.token()` cannot widen beyond the inferred or narrowed manifest set: `raw token rejects a
  broader explicit scope than the inferred manifest set`.
- Missing `ctx.user` refuses the broker before minting: `missing ctx.user refuses the broker before
  minting`.
- The requested subset baked into the manifest must match actual called operations: `manifest allow
  must match the actually observed connector operations`.

Scope boundaries:

- Authoring surface and typed-client generation stay in `connector-authoring-contract`.
- Static operation-to-scope inference stays in `xaa-scope-inference-contract`.
- ID-JAG minting and target authorization-server redemption stay in
  `outbound-xaa-token-exchange-contract`.
- Policy deny-ceiling enforcement is not implemented here.
