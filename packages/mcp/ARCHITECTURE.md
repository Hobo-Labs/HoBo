# @hobo/mcp — architecture

The MCP control surface (S3-01/S3-02) exposes HoBo's operations to agents over
the Model Context Protocol. Design source:
[`ai-native-agent-auth.md`](../../docs/design/ai-native-agent-auth.md) §6.4 (MCP
control surface) and §6.1–6.2 (identity), with the inert-tool-output invariant
from [ADR-0023](../../docs/design/adr/02-identity-security.md#adr-0023) item 3.

## Boundaries and inward dependencies

`src/` depends only inward: `@hobo/core` (the port vocabulary), `@hobo/cli` (the
shared dispatch layer + `CANONICAL_VERBS`), and `@hobo/identity` (SVID scope).
The infra adapters that build a `YardRuntime` — `@hobo/cloud`,
`@hobo/runtime-local`, `@hobo/provider-cloudflare`, `@hobo/data` — are injected
through the `HoboCli` the server wraps and are test-only devDependencies; they
are never imported by `src/`.

## Parity (NFR-004)

`tool-surface.ts` derives the tool set from `CANONICAL_VERBS` 1:1, so the
agent-facing surface cannot drift from the CLI. `assertToolSurfaceParity` fails
for any divergent hand-list. `server.ts` dispatches every tool through the same
`@hobo/cli` command registry (`hobo <verb> --json`) — there is no second
implementation of plan/up/down.

## Capability scoping and audit (S3-02)

`auth.ts` composes `@hobo/identity`: it verifies the caller's JWT-SVID at the
Yard gateway and checks each tool's required capability against the SVID scope,
deny-by-default. Every allow/deny is an audited `mcp.ToolCallDecided` decision
carrying the never-compact credential-audit retention.

## Event architecture

Every **command** the surface accepts becomes an **event**; the Yard's
**actors** fold those events in the **event store**, and **projections**
(**materialized views**) plus periodic **snapshots** serve the **read store**
(the S2-01 catalog + S3-04 CredentialAudit projection). The MCP server itself is
stateless over that log — it only emits decision facts.

## Data models (parse, don't validate)

`data-models/mcp.proto` + `mcp.cue` are the wire records (one CUE constraint per
proto message/enum). The `src/` surface follows **parse, don't validate**:
these wire forms are narrowed into **derived domain types** built only by this
package's constructors, never re-declared as parallel wire interfaces.

## Contracts

`contracts/pacts/` holds the lifted `mcp-control-surface` and
`identity-policy-boundary` pacts; `contracts/consumer/` verifies the real server
realizes their recorded interactions (SVID-scoped agent can call a tool;
missing scope is denied, fail-closed).

## Secret-capture MCP App

`src/secret-capture/` is a second, separate surface: MCP App tools that are
not CLI verbs, so they sit outside the NFR-004 parity set by design and are
composed beside it (`hobo-mcp` lists both and gates both by SVID scope with
the same `capabilityForTool` triples). Its only inward dependency beyond this
package is the `SecretStoreConnector` port it is given; it imports no store
adapter. Each step is an audited `secret.Capture*` fact
(`hobo.secret-capture/v1`, references only). Its records are generated from
`data-models/secret_capture.proto` (this package's first `buf.yaml` module),
and its form follows [`DESIGN.md`](./DESIGN.md).

