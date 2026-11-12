# @hobo/mcp

The MCP server that exposes HoBo's control surface to agents (S3-01/S3-02). It
maps every tool to a canonical CLI verb over the **same** `@hobo/cli` dispatch
path — there is no second implementation of plan/up/down — and gates each call
by the caller's SVID scope (deny-by-default), with inert tool output.

- `src/tool-surface.ts` — derives the tool list from `CANONICAL_VERBS`
  (NFR-004 parity; a divergent hand-list fails `assertToolSurfaceParity`).
- `src/server.ts` — `listTools()` / `callTool(name, input, auth)` dispatching
  through an injected `HoboCli` (wired to a `YardRuntime`).
- `src/auth.ts` — composes `@hobo/identity` for SVID scope, emits audited
  `mcp.ToolCallDecided` decisions, and proves the ADR-0023 inert-output rule.

- `src/secret-capture/` — the secret-capture MCP App (below).

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and
[`ai-native-agent-auth.md`](../../docs/design/ai-native-agent-auth.md) §6.4.

## Scripts

- `pnpm --filter @hobo/mcp run build` — `tsc`
- `pnpm --filter @hobo/mcp run test` — vitest (parity, scripted plan→up,
  scope denial, inert output, pact consumer)
- `pnpm --filter @hobo/mcp run test:contract:consumer` — the pacts, the
  secret-capture MCP App pact included

## Secret-capture MCP App

When an agent runs a HoBo deployment and a secret is missing, the owner types
it into a HoBo form and it goes to the secret store without passing through
the agent ([ADR-0179 amendment](../../docs/design/adr/hosted-relay-stateless.md#amendment-secretless-first)).
Built against the MCP Apps extension `io.modelcontextprotocol/ui`,
specification **2026-01-26** (`github.com/modelcontextprotocol/ext-apps`, the
types of `@modelcontextprotocol/ext-apps` 2.0.4, read 2026-11-12), and MCP
**2025-11-25** URL-mode elicitation. No SDK is a dependency: the form speaks
the protocol over `postMessage` itself, and the composing server
(`@hobo/hobo`'s `hobo-mcp`) speaks JSON-RPC itself.

| Piece | File |
|---|---|
| Tools, resource, tickets, channel choice | `src/secret-capture/app.ts` (`createSecretCaptureApp`) |
| The form (MCP App resource and loopback page) | `src/secret-capture/html.ts`; visual contract [`DESIGN.md`](./DESIGN.md) |
| Sealing (ECDH-ES P-256, HKDF-SHA256, AES-256-GCM) | `src/secret-capture/seal.ts`; the browser source `SECRET_CAPTURE_SEAL_SOURCE` is what the tests run |
| Loopback fallback page | `src/secret-capture/loopback.ts` |
| Size, charset and shape checks; the redacting value | `src/secret-capture/value.ts` (`CapturedSecret`) |
| Records | [`data-models/secret_capture.proto`](data-models/secret_capture.proto) + [`.cue`](data-models/secret_capture.cue), fixtures in `data-models/fixtures/secret_capture/` |
| Boundary | [`contracts/pacts/secret-capture-mcp-app.pact.json`](contracts/pacts/secret-capture-mcp-app.pact.json) |

**Tools.** `capture_secret {name, writerClientId?, channel?, replace?}`
(model-visible; `_meta.ui.resourceUri: "ui://hobo/secret-capture"` for an MCP
Apps host) opens a ticket; `submit_secret_value {ticketId, sealed}` is the
form's own tool, listed only to an MCP Apps host and with
`_meta.ui.visibility: ["app"]`; `secret_capture_status {ticketId}` reads a
ticket's state and reference; `end_secret_capture {}` closes open tickets and
ends the writer session. The resource is `text/html;profile=mcp-app` with
empty CSP domain lists.

**Channels.** The host's `initialize` capabilities decide: an MCP Apps host
renders the form; a client with `elicitation.url` gets
`URLElicitationRequiredError` (-32042) naming a `127.0.0.1` page this process
serves, and `notifications/elicitation/complete` after the write; a client with
neither gets the page's address and an instruction that the owner opens it.
Form-mode elicitation is never used (the MCP spec forbids it for secrets).

**What never leaves.** The value exists sealed in transit and as a
`CapturedSecret` (prints `[redacted secret]`) in this process until the
connector's single `reveal()`. Results are tickets, then `{ticketId, name,
stored, ref, status}`; refusals carry a code and a reason, never the value.
Nothing in `src/secret-capture/` writes a log line. The tests feed random
synthetic values through every path and assert that no tool result, refusal,
event, page, HTTP answer, console line or stdout/stderr write contains the
value (raw, JSON-escaped, base64 or a 16-character slice), and that the watch
does catch a planted leak.

**The store** is an injected `SecretStoreConnector`: `status()` (connected?
writable?), `authorizeWriter()` (a one-use credential that authorizes writes
for the session, never stored), `store(target, secret)` and
`endWriterSession()`. `@hobo/hobo` supplies the Infisical one; the tests use a
memory `SecretsPort`. With no store connected `capture_secret` refuses with
`SECRET_STORE_NOT_CONNECTED` and the composition's next step.

**Gates.** TypeScript (`tsc`), Protobuf (`pnpm run codegen`, opted in by
`data-models/buf.yaml`; `src/_generated/`), CUE (closed definitions vetted
against `fixtures/secret_capture/{valid,invalid}`), PACT
(`contracts/consumer/secret-capture.test.ts`), design lint
(`pnpm run design:lint` and `test/secret-capture-design-lint.test.ts`).
