# CLI/MCP Parity Resource Lifecycle Contracts - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-570. It records command/tool
shape decisions without implementing a production CLI parser, auth broker, MCP runtime, dashboard,
or live provider integration.

## Decision

Define CLI and MCP lifecycle contracts from one shared Gateway command path. `hobo up` remains the
only lifecycle mutation verb for deploy, promote, and rollback, while `collect`, `plan`, `inspect`,
`logs`, `doctor`, `import`, and migration evidence expose read or supporting flows around it.

## Alternatives Considered

- Standalone `hobo deploy`, `hobo promote`, and `hobo rollback` verbs: rejected because
  `docs/design/developer-experience.md#plan-07` already collapses lifecycle mutation into `up` plus
  flags.
- UI-first dashboard behavior: rejected because HOBO-570 is the terminal and MCP contract source
  for later visual surfaces.
- Live MCP/auth/server implementation: rejected because this proof only pins shapes and reference
  fixtures.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted CLI/MCP parity records are
parsed once at the boundary into a derived parsed contract type. Downstream functions consume the
parsed derived type instead of rechecking broad DTO strings for every call. The CUE constraints
bound the same derived types so missing commands, unlabeled proof modes, mismatched result
envelopes, and scope-creep command verbs fail before consumers use the record.

## Event Architecture

The parity checker now compares both the CLI invocation intent against the MCP tool/input and the
result envelope. This keeps transcript fixtures from passing when the output happens to match but
the tool target or input fields drift.

The accepted contract is the read model behind a small event flow:

- **Command** - `cliMcpParity.RecordRequested` asks the DX contract owner to accept or amend the
  CLI/MCP parity record.
- **Event** - `cliMcpParity.RecordAccepted` appends the parsed operation/tool map, fixture evidence,
  and proof-mode labels.
- **Actor** - the CLI/MCP Developer Experience proof owner is the aggregate that applies accepted
  record events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current
  CLI/MCP parity contract read model.
- **Snapshot** - the current accepted parity contract is the projection snapshot consumed by docs,
  transcript, and dashboard follow-up issues.
- **Read store** - downstream surfaces query the read store rather than raw comments or ad hoc
  transcripts.

No runtime engine, CLI parser, MCP server, auth broker, dashboard, or provider integration is
implemented here.
