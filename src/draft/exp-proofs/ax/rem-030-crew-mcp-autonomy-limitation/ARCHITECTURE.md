# REM-030 Crew/MCP Autonomy Limitation - Architecture Evidence

Architecture-guard evidence for HOBO-697. This package validates that the
design-doc register and executable contract agree on Crew/MCP write autonomy
being policy-gated.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Untrusted markdown register rows and contract payloads parse once into the
`ParsedCrewMcpAutonomyLimitation` parsed domain type before acceptance checks
run. CUE constraints bound the same derived type so missing Crew/MCP rows or
unsupported autonomy marketing claims are rejected at the boundary.

## Event Architecture

The accepted limitation row is the read model behind a small event flow:

- **Command** - a request to register or review a Crew/MCP autonomy limitation.
- **Event** - successful commands append `release.limitation.*` evidence facts.
- **Actor** - the release-note limitation aggregate applies events in order.
- **Event store** - accepted facts append to the durable release-readiness event
  store.
- **Materialized view / projection** - a projection folds events into current
  limitation state and launch-messaging guard freshness.
- **Snapshot** - the register row is the customer-facing snapshot for release
  notes, docs, support, and messaging.
- **Read store** - consumers query the snapshot instead of inferring unsupervised
  Crew/MCP autonomy from marketing copy.

No release CMS, event store, or production publishing system is implemented
here; this is design-time contract evidence naming the command, event, actor,
projection, PACT, protobuf, and CUE boundaries.
