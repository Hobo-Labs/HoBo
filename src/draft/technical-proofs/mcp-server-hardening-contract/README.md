# MCP Server Hardening Contract

HOBO-194 pins the adversarial security contract for the `@hobo/mcp` control
surface. It proves the MCP server treats agents as scoped principals, routes
every tool call through the policy plane, and treats tool descriptions/results
as untrusted data rather than executable instructions.

## Scope

- MCP tool calls create `policy.Decided` audit events using the shared
  `hobo.policy-ir/v1` contract.
- Tool invocation is deny-by-default: unknown tools and tools missing from the
  agent grant are uncallable.
- Destructive/prod tools return a pending `createHook` approval obligation and
  do not execute before human approval.
- Approval resolution enforces separation of duties: the requesting agent cannot
  approve its own gated action.
- `request_token` only grants exact delegated token scopes and emits
  `token.Granted` or `token.Denied` through the shared identity event contract.
- Tool output is recorded as inert data; prompt-injected output never schedules
  a second tool call.
- Grant revocation halts a run mid-plan, and the user -> agent -> action ->
  token audit chain is reconstructible from events.
- Agent spend caps throttle repeated calls before execution.

## Out of Scope

- A production MCP transport, JSON-RPC server, OAuth/XAA implementation, or real
  policy engine.
- Dashboard approval UI or Slack approval delivery.
- Runtime execution of deploy/destroy operations.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\mcp-server-hardening-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Mcp Server Hardening Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
