# HOBO-194 MCP Server Hardening Proof

HOBO-194 hardens the MCP control surface against prompt injection and over-broad
agent permissions. The executable proof lives in
[`src/draft/technical-proofs/mcp-server-hardening-contract`](../../../../src/draft/technical-proofs/mcp-server-hardening-contract)
and is intentionally a contract POC, not the production MCP runtime.

## Proven Acceptance

- Adversarial scope-escalation transcripts are denied with `policy.Decided`.
- Destructive/prod MCP calls return a `createHook` approval obligation and do not
  auto-apply.
- Prompt-injected tool output is inert data and cannot trigger an out-of-scope
  follow-up tool call.
- Over-broad `request_token` calls emit `token.Denied` before any grant.
- The user -> agent -> action -> token chain is reconstructible from audit
  events and grant revocation stops the agent mid-plan.
- Unknown or ambiguous tools fail closed.
- Spend caps throttle an over-eager agent before execution.

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\mcp-server-hardening-contract test
```

This proof consumes the shared policy IR and identity event contracts, so the
audited facts match the existing HoBo design records rather than a local-only
shape.
