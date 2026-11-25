# CLI Manage Inspect Logs Drift Prototype

HOBO-574 proof for terminal manage transcripts that cover inspect, logs, drift,
and support handoff states from accepted reference fixtures.

## What This Proves

- `hobo inspect`, `hobo logs`, and `hobo doctor` render human terminal output and
  machine-readable JSON for normal operation, stale projections, non-reactive
  sinks, drift, support handoff, and redacted evidence packs.
- Every transcript is fixture-backed by run inspector, projection freshness, log
  cursor, drift, token/audit, and support evidence records.
- CLI transcript intent and MCP tool calls stay semantically equivalent for each
  manage state.
- Reference fixture copy never implies live state, live log streaming, customer
  data access, real support automation, or dashboard-first behavior.

## Audience Model

- App developers need scriptable inspect/log/doctor output that is honest about
  fixture mode.
- SREs and operators need stale projection, non-reactive sink, and drift states
  to be explicit before using evidence for rollout decisions.
- Support engineers need redacted support bundles that preserve correlation IDs
  without exposing customer payloads, provider credentials, or raw logs.
- Agent and MCP callers need the same status, remediation, and redaction
  semantics as the CLI transcript.

## Required Manage States

| State | CLI shape | MCP tool | Fixture evidence |
|---|---|---|---|
| Normal operation | `hobo inspect run <id> --json` | `hobo.inspect` | Run inspector, projection freshness, log cursor |
| Stale projection | `hobo inspect topology --json` | `hobo.inspect` | Projection freshness, run inspector |
| Non-reactive sink warning | `hobo inspect deploy <id> --json` | `hobo.inspect` | Projection freshness, run inspector |
| Drift detected | `hobo doctor --resource <name> --json` | `hobo.doctor` | Drift, run inspector, support evidence |
| Support handoff | `hobo doctor --support-bundle <id> --json` | `hobo.doctor` | Support evidence, token/audit, projection freshness |
| Redacted evidence pack | `hobo logs --follow <resource> --json` | `hobo.logs` | Log cursor, token/audit, support evidence |

## Scope

In scope: reference fixture transcript records, human terminal rendering,
machine JSON rendering, CLI/MCP parity checks, redaction evidence, fixture source
coverage, and scope guards.

Out of scope: production observability pipelines, live log streaming, real
support tooling, customer data, and dashboard-first run inspector mockups.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cli-manage-inspect-logs-drift-prototype test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for transcript
  scenes, fixture sources, redaction, CLI commands, MCP calls, and machine
  results.
- `architecture/pacts/` - Pact-style CLI/MCP parity boundary fixture for the
  parsed transcript prototype.
- `ADR.md` - parse-don't-validate and event-architecture evidence for this
  independent draft POC.
