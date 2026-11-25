# CLI Manage Transcript Architecture

This proof is a fixture-backed contract for manage transcripts, not a production
CLI, MCP server, log streamer, or support workflow.

## Boundary

The package parses one transcript prototype:

- issue: `HOBO-574`
- phase: `M2`
- package: `src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype`
- proof note:
  `docs/design/proofs/cli-manage-inspect-logs-drift-prototype/README.md`

The parser accepts only the six required manage states, the accepted fixture
source vocabulary, `reference fixture` proof mode, redaction evidence, and
semantic CLI/MCP parity. Parse don't validate constructors return derived
parsed types after protobuf and CUE constraints pass.

## Command, Event, and Projection Shape

- Commands are read-only inspect/log/doctor transcript intents.
- Events are represented as replay-derived fixture facts: projection freshness,
  ResourceActor timeline state, log cursor replay, drift findings, token/audit
  evidence, and support bundle evidence.
- Projections are snapshots. Stale and non-reactive projection evidence is
  labeled as such and never presented as live state.
- Redaction is part of the parsed object so support handoff cannot omit withheld
  fields.

## Contract Gates

- TypeScript tests prove parser invariants, human rendering, JSON rendering,
  CLI/MCP parity, Pact fixture alignment, CUE field coverage, and scope guards.
- Protobuf records define transcript, CLI, MCP, result, human, and redaction
  shapes.
- CUE constraints pin the issue, target package, proof note, proof mode, fixture
  source vocabulary, and six required scene count.
- Pact fixture captures the CLI/MCP boundary with the complete parsed prototype.
