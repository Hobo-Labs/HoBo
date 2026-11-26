# HOBO-176 Operations Manifests Contract

This POC publishes the operations-facing `llms.txt`, `llms-full.txt`, and
`docs.json` manifests from the same canonical inputs as the CLI and MCP draft
surfaces.

## What It Proves

- `llms.txt`, `llms-full.txt`, and `docs.json` generate from the HOBO-8 CLI verb
  table and HOBO-168 MCP tool table.
- `/llms.txt`, `/llms-full.txt`, and `/docs.json` are stable well-known serving
  paths.
- `docs.json` validates as `hobo.operations.docs/v1`.
- `docs.json` carries MCP `inputSchema` and `outputSchema` metadata so agents can
  call tools without scraping implementation code.
- Routes cover both CLI-backed commands and MCP-first operations such as
  `list_bindles`, `request_token`, `rollback`, and `heal`.
- Drift is detected if a CLI verb or MCP tool is added without regenerating the
  published manifests.
- Internal-only tools and bearer/secret-shaped material are excluded or redacted.
- Missing tool descriptions get a deterministic default plus an explicit
  metadata warning instead of silently looking complete.
- Agents can route common intents, such as deploy or logs, without scraping human
  docs.

## Scope Boundary

This package does not implement the production Yard web surface, the production
MCP server, per-app authoring manifests, or the human docs site. It pins the
contract shape and drift checks those later implementations must satisfy.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\operations-manifests-contract run generate
npm.cmd --prefix src\draft\technical-proofs\operations-manifests-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Operations Manifests Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
