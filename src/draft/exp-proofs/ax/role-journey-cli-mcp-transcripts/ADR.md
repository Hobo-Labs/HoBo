# ADR - Role Journey CLI and MCP Transcripts

## Decision

Represent `HOBO-557` as a deterministic experience proof package that renders
six role-specific terminal transcripts and equivalent MCP tool results from the
accepted `HOBO-577` quickstart fixture ids. The package is CLI-first and uses
JSON/MCP result shapes as the machine-readable companion for each terminal
step.

## Alternatives

- Build production CLI or MCP runtime behavior. Rejected because this issue
  proves examples only; runtime implementation belongs to later slices.
- Create dashboard mockups for the six journeys. Rejected because visual
  mockups are explicitly secondary and must not invent behavior beyond the
  DX quickstart.
- Copy quickstart fixture data into this package. Rejected because downstream
  role examples must keep a durable link to `HOBO-577` fixture ids.

## Parse Boundary

This package follows parse, don't validate: raw role journey records cross
`parseRoleJourneyCliMcpTranscripts` once and become the parsed derived type
`RoleJourneyCliMcpTranscripts`. Renderers accept parsed `RoleJourney` and
`RoleJourneyStep` records instead of rechecking raw DTOs.

## Event Architecture

Command: `RenderRoleJourneyCliMcpTranscripts`.

Events: `roleJourneyCliMcpTranscripts.Accepted` when every role, fixture,
coverage, support, accessibility, and MCP parity condition is present;
`roleJourneyCliMcpTranscripts.Rejected` when scope or fixture evidence is
missing.

Actors: app developer, platform engineer, GitOps, SecOps, DevOps, and SRE.

Event store: the accepted `HOBO-577` quickstart fixture ids are treated as the
source event stream for downstream role transcript projections.

Projection: terminal transcript text, JSON results, and MCP tool results are
materialized views over parsed role journey steps.

Snapshots: each step records the quickstart fixture id, proof mode, support
handoff, and accessibility note as a stable review snapshot.

Read store: docs, tutorials, launch-demo, support, and later visual mockup
slices consume the rendered transcript and MCP result read models; Linear
remains authoritative for issue state.
