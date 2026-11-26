# CLI/MCP Parity Resource Lifecycle Contracts

HOBO-570 proof for terminal-first lifecycle command contracts and their MCP tool equivalents.

## What This Proves

- `hobo collect`, `hobo plan`, `hobo up`, `hobo inspect`, `hobo logs`, `hobo doctor`,
  `hobo import`, and the migration flow share the same Gateway command path as MCP tools.
- `hobo up` is the only lifecycle mutation verb for deploy, promote, and rollback; those behaviors
  remain flags or modes, not standalone verbs.
- Brownfield import produces `resource.Adopted` evidence that feeds `plan` and migration; migration
  consumes that adopted-resource state before entering the gated `up` path through expand,
  backfill, and contract.
- CLI invocation intent, MCP tool input, JSON output, and MCP tool results are semantically
  equivalent for success, blocked, stale, non-portable, and support-handoff fixture outcomes.
- Scope guards reject production parser/runtime work, live auth or MCP runtime wiring, dashboard
  implementation, and lifecycle verbs not already accepted in the design docs.

## Audience Model

- App developers need terminal commands that are scriptable and honest about proof mode.
- Agent and MCP callers need machine-readable tool schemas with the same semantics as CLI output.
- Platform engineers need plan/up/import/migration outcomes that preserve Gatekeeper and Delta/Set
  vocabulary.
- Support engineers need redacted evidence from `inspect`, `logs`, and `doctor` without customer
  data or live provider access.

## Required Operations

| Operation | CLI shape | MCP tool | Safety | Notes |
|---|---|---|---|---|
| collect | `hobo collect [--camp <camp>] [--json]` | `hobo.collect` | read | Emits manifest IR fixture evidence. |
| plan | `hobo plan [--camp <camp>] [--json]` | `hobo.plan` | read | Emits DeploymentPlan, warnings, and Gatekeeper preflight output. |
| up | `hobo up [--camp <camp>] [--strategy <strategy>] [--to <revision>] [--rollback] [--json]` | `hobo.up` | write | Subsumes deploy, promote, and rollback. |
| inspect | `hobo inspect run <id> \| deploy <id> \| topology [--json]` | `hobo.inspect` | read | Reads projection snapshots. |
| logs | `hobo logs [--follow] [<resource>] [--json]` | `hobo.logs` | read | Reads runtime stream fixtures. |
| doctor | `hobo doctor [--json]` | `hobo.doctor` | read | Emits diagnostics and support-safe evidence. |
| import | `hobo import terraform\|pulumi\|opentofu <src> [--json]` | `hobo.import` | write | Produces `resource.Adopted`; feeds `plan` and migration. |
| migrate | `hobo plan --migration <fixture> --adopted-resource <id> && hobo up --camp <camp> [--json]` | `hobo.migrate` | write | Consumes adopted-resource state, then expands, backfills, and contracts through the gated `up` path. |

## Fixture Outcomes

The proof pins five reference fixtures:

- `successful-deploy` - `hobo up` converges a preview Camp from an accepted plan.
- `blocked-deploy` - Gatekeeper denies a prod Delta with an actionable remediation.
- `stale-projection` - `hobo inspect` labels lagged projection evidence.
- `non-portable-edge` - `hobo plan` surfaces raw/adopted resource debt.
- `support-handoff` - `hobo doctor` emits support-safe redacted evidence.

## Scope

In scope: command and MCP schema shapes, MCP input fields, output envelopes, invocation and result
semantic parity checks, fixture outcome records, proof-mode labels, and scope guards.

Out of scope: production argument parsing, live auth broker, live MCP server, dashboards, live
providers, customer data, and new command behavior not present in the design docs.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cli-mcp-parity-resource-lifecycle-contracts test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for operations and result envelopes.
- `architecture/pacts/` - PACT contract for the CLI/MCP parity boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
