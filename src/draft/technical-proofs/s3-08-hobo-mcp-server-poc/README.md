# S3-08 @hobo/mcp Server POC (HOBO-634)

Independent draft POC for `@hobo/mcp`: SVID-bound MCP server with Gateway CLI
call-path parity, per-principal/per-tenant rate limits, and published
operations manifests.

## What It Proves

- **NFR-004 surface parity** — every canonical CLI verb maps to an MCP tool;
  `assertSurfaceParity()` fails on CLI/MCP schema drift.
- **FR-020 Gateway call path** — `plan`/`deploy` dispatch through the same
  `createHoboCli` path as `hobo plan`/`hobo up`.
- **SVID auth** — write tools require verified SVID; per-tool capability
  scoping fails closed (composed from `hobo-mcp-server-contract`).
- **NFR-019 rate limits** — flooding principal gets typed `MCP_RATE_LIMITED`
  with `retryAfterMs`; other principals on the same tenant proceed.
- **NFR-015 operations manifests** — `llms.txt`, `llms-full.txt`, and
  `docs.json` generated from the live CLI + MCP tool registry.

## Scope Boundary

Draft POC only. Does not implement production JSON-RPC transport, Yard
Gateway HTTP server, Identity issuer, Registry search backend, or token-broker
runtime. Promotes fixtures from `src/draft/epic-proofs/cli-mcp-developer-experience/`
and composes `hobo-mcp-server-contract`, `operations-manifests-contract`, and
`hobo-cli-shell-contract`.

Production promotion target: `packages/mcp/` once S3-02 (HOBO-628) and S3-04
(HOBO-630) contracts are on `main` (merged).

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s3-08-hobo-mcp-server-poc test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Gates

| Gate | Protects |
|---|---|
| TypeScript tests | SVID auth, surface parity, rate limits, manifests |
| Protobuf + CUE | MCP gateway record shapes |
| PACT | Gateway MCP boundary expectations |
| `pnpm agent:check -- --staged` | Docs freshness + architecture guard |

## Testing

Run `pnpm --filter @hobo-draft/s3-08-hobo-mcp-server-poc test` (Vitest). The
adversarial scope-denial case pins the SVID auth clock (server `now`) before the
fixture SVID's expiry so the scope check — not an expiry check — is what fails.
