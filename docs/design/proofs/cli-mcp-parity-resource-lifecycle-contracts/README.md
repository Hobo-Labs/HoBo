---
type: Reference
title: "CLI MCP Parity Resource Lifecycle Contracts Proof"
description: "Source issue: HOBO-570."
tags: [hobo, design]
---

# CLI/MCP Parity Resource Lifecycle Contracts Proof

HOBO-570 records the terminal-first lifecycle contracts that later docs, transcripts, dashboards,
and MCP examples must reuse.

## Evidence

- Proof package: [`../../../../src/draft/exp-proofs/ax/cli-mcp-parity-resource-lifecycle-contracts/README.md`](../../../../src/draft/exp-proofs/ax/cli-mcp-parity-resource-lifecycle-contracts/README.md)
- Source designs:
  - [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07)
  - [`sdk-api.md#plan-02`](../../sdk-api.md#plan-02)
  - [`control-plane.md#plan-04`](../../control-plane.md#plan-04)
  - [`platform-engineering.md#plan-25`](../../platform-engineering.md#plan-25)
  - [`data-plane.md#plan-32`](../../data-plane.md#plan-32)

## Acceptance Mapping

- Command synopsis, flags, stdout/stderr, JSON result, exit codes, MCP schema IDs, and MCP input
  fields are pinned for `collect`, `plan`, `up`, `inspect`, `logs`, `doctor`, `import`, and
  migration.
- `up` owns deploy, promote, and rollback modes through `--camp`, `--to`, and `--rollback`; no
  standalone lifecycle verbs are introduced.
- Brownfield import feeds `plan` and migration through `resource.Adopted`, and migration consumes
  that adopted-resource state before feeding `up` through expand, backfill, and contract phases.
- Fixture outcomes cover success, blocked deployment, stale projection, non-portable edge, and
  support handoff.
- CLI transcript invocation, MCP tool input, and result envelopes are compared for semantic parity.

## Proof Command

```powershell
npm.cmd --prefix src\draft\exp-proofs\cli-mcp-parity-resource-lifecycle-contracts test
```

## Scope Boundary

This proof does not implement a production CLI parser, live auth broker, live MCP server, dashboard,
live provider, customer-data flow, or command behavior outside the accepted design docs.
