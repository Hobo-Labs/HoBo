# HOBO-168/HOBO-173 MCP Server Contract

This POC pins the `@hobo/mcp` operations surface without building a production
MCP server, Yard runtime, auth provider, issuer, token-broker runtime, or
dashboard. It proves tool metadata, input/output schema validation, CLI
call-path parity, progress streaming, SVID-bound session authorization, and the
`request_token` broker seam against local fixtures.

## What It Proves

- The documented MCP tools are listed with JSON-schema-shaped inputs/outputs and
  explicit read/write/destructive annotations.
- `plan` and `deploy` dispatch through the same shared CLI call path as
  `hobo plan` and `hobo up`.
- CLI-backed `deploy` forwards long-running `hobo up` progress callbacks through
  the MCP progress channel.
- `inspect_run` returns projection data and `tail_logs` can stream progress.
- Each canonical CLI verb has a pinned MCP parity mapping, and CLI/MCP input
  schema drift fails the parity assertion.
- Malformed inputs produce structured errors.
- Anonymous mutation tools fail closed, while read-only tools remain callable.
- `request_token` delegates to the token-broker seam with the authenticated
  principal injected as the subject.
- Stdio and HTTP transport descriptors are exposed for the future server.
- A SVID-bound MCP session verifies the SVID assertion before each tool call and
  requires the session to hold the per-tool `hobo:mcp/tool:<name>/call`
  capability.
- `request_token` is routed through the injected broker with a SVID scope
  narrowed to the requested `(port, resource, action)` tuple.
- Token broker output is redacted before return or audit, and token
  `Granted`/`Used`/`Revoked` events retain the triggering MCP tool-call id.
- Expired, revoked, replayed, forged, anonymous, and over-scope sessions fail
  closed with structured errors and auditable policy decisions.

## Scope Boundary

This package intentionally does not implement the Identity issuer, JWKS
verification internals, broker/provider internals, prompt-injection hardening,
editor integration, production transports, Yard runtime handlers, or dashboard
surfaces. Those remain owned by adjacent Identity, policy, runtime, and DX
slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-mcp-server-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Mcp Server Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
