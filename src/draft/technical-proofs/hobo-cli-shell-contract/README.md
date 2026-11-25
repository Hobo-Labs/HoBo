# HoBo CLI Shell Contract POC

HOBO-115 proof for the `@hobo/cli` shell boundary.

> **Promotion (S1-20 / HOBO-610):** shell behavior is implemented in production package [`packages/cli`](../../../../packages/cli/) (`src/shell/*`, `dispatchCommand` seam). This proof remains the contract reference until the production package fully replaces it in CI lanes.

## What This Proves

- `hobo --help` is pinned to the canonical HOBO-8 verb table and global flags.
- `hobo <verb> --help` routes through the same registry metadata as normal dispatch.
- `hobo plan --json` emits one machine-readable stub envelope on stdout.
- Human output and JSON output are mutually exclusive on stdout.
- Unknown verbs suggest the nearest canonical verb without guessing silently.
- Unknown flags and conflicting lifecycle flags fail during parse with actionable messages.
- Command context is constructed once and injected into the dispatched command.
- Project-scoped verbs fail outside a Bindle directory with a clear no-Bindle error.

## Boundary

This is an executable shell contract, not the production CLI implementation. It does not implement
real verb behavior, authentication, MCP server transport, provider calls, planning, deployment,
resource collection, or runtime clients. Each canonical verb returns a structured "not yet
implemented" stub so later slices can plug into the same parser, registry, context, and renderer
shape.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-cli-shell-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Cli Shell Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
