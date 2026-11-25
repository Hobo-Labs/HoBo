# HOBO-173 MCP SVID Auth Proof

This executable proof pins MCP tool authorization from
[Plan 6](../../ai-native-agent-auth.md#plan-06),
[Plan 7](../../developer-experience.md#plan-07),
[ADR-0008](../../adr/02-identity-security.md#adr-0008),
[ADR-0014](../../adr/03-data-plane.md#adr-0014), and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

## Contract Surface

- The proof package is
  [`src/draft/technical-proofs/hobo-mcp-server-contract`](../../../../src/draft/technical-proofs/hobo-mcp-server-contract).
- `createSvidBoundHoboMcpServer` binds every tool call to an injected SVID
  verifier result and passes the verified agent principal into the MCP tool
  runtime.
- Per-tool capabilities use `hobo:mcp` scopes with `tool:<name>` resources and
  `call` actions; missing capabilities fail closed with `MCP_SCOPE_DENIED`.
- `request_token` is brokered only after the session holds the MCP tool
  capability and the requested provider scope is inside the verified SVID scope.
- Provider token scope is narrowed to the requested
  `(port, resource, action)` tuple before the broker sees it.
- Token credential responses and token audit events are stripped of plaintext
  token fields before they leave the wrapper or enter the audit sink.
- Token audit records preserve the triggering MCP tool-call id across
  `token.Granted`, `token.Used`, and `token.Revoked`.

## Proof Boundaries

This proof stays at the MCP/Identity contract seam. It does not implement the
SVID issuer, JWKS validation internals, broker/provider internals, deny-ceiling
composition, prompt-injection defenses, or the base MCP tool catalog.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-mcp-server-contract test -- --test-name-pattern SVID
```

The focused tests cover the HOBO-173 acceptance and adversarial cases: verified
SVID requirement, per-tool capability gating, scoped token brokering,
over-scope denial before broker dispatch, expired SVID re-authentication,
revoked SVID mid-session mutation denial, forged/replayed assertion rejection,
scope narrowing per call, and plaintext-token audit redaction.
