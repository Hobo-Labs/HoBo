# HOBO-168 MCP Server Proof

This proof records the branch-local contract package for HOBO-168.

## Issue Boundary

- Scope in: documented MCP tools, JSON-schema-shaped inputs/outputs, CLI shared
  call-path parity, `inspect_run`/`tail_logs` projection/stream behavior,
  long-running `deploy`/`up` progress callbacks, malformed-input errors,
  mutation auth fail-closed behavior, `request_token` broker delegation,
  CLI/MCP schema-drift detection, and stdio/HTTP transport descriptors.
- Scope out: SVID scoping per tool, prompt-injection hardening, VS Code/editor
  UI, production Yard transports, and production runtime handlers.

## Executable Proof

- Package: `src/draft/technical-proofs/hobo-mcp-server-contract`
- Focused gate: `npm.cmd --prefix src\draft\technical-proofs\hobo-mcp-server-contract test`

The tests exercise all acceptance bullets and adversarial cases in HOBO-168,
including output-schema metadata, deploy progress streaming, and schema-drift
parity failures.
