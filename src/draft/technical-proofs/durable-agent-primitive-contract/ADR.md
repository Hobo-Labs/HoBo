# Durable Agent Primitive Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted agent definitions and tool inputs are normalized once at the runtime
boundary into **parsed derived types**. Downstream replay and audit consumers
receive those derived types instead of re-checking raw DTOs.

## Event Architecture

- **Command** — `agent.run` starts a durable agent execution.
- **Event** — tool steps and token grants append to the agent run event log.
- **Actor** — the agent run aggregate owns step ordering and replay state.
- **Event store** — accepted events are appended to the event store as the durable source of truth.
- **Materialized view / projection** — run output and tool results fold from the projection.
- **Snapshot** — cached step results enable replay-without-reexecution.
- **Read store** — downstream surfaces query the read store for current run state.

No production runtime engine is implemented here; this is a design-time contract
that names the command, event, actor, and projection boundaries for HOBO-632.
