# ADR: Resource lifecycle quickstart examples

## Status

Accepted for `HOBO-577`.

## Context

The resource lifecycle proof family now has a scenario matrix, SDK object graph
shapes, CLI/MCP parity, and deploy/manage/migrate transcript work in flight.
Downstream docs, tutorials, launch, workspace, plan/diff, and dashboard issues
need one canonical quickstart source so they do not invent lifecycle behavior or
unsafe launch claims.

## Decision

Define the canonical quickstart under
`src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples`.

The quickstart is an executable fixture contract. It covers define, collect,
plan, deploy, inspect, manage, migrate, and recover. Each phase carries SDK, CLI,
API, and MCP snippets with fixture ids, proof-mode labels, and safe claims.

The parser follows Parse, don't validate: raw quickstart data crosses
`parseResourceLifecycleQuickstartExamples` once, then downstream consumers get a
branded parsed derived type. The parser enforces phase coverage, channel
coverage, fixture id shape, proof-mode labels, safe-claim boundaries, and
required handoff consumers.

## Architecture notes

- Commands: quickstart snippets cover `hobo new`, `hobo collect`, `hobo plan`,
  `hobo up`, `hobo inspect`, `hobo doctor`, `hobo import terraform`, and
  rollback preview.
- Events: DeploymentPlan, Gatekeeper, ResourceActor, Delta, migration, stale
  projection, and recovery evidence remain fixture-backed event/projection
  surfaces.
- Actors: ResourceActor is represented by replayable timeline fixture ids; this
  proof does not implement actor execution.
- Event store: accepted deployment, migration, stale-evidence, and recovery
  rows are described as replayable fixture evidence.
- Materialized view / projection: inspect and manage snippets read fixture
  projections and label stale evidence explicitly.
- Snapshot / read store: downstream consumers receive named fixture ids and
  handoff notes as snapshots, not production read-store behavior.
- PACT/Protobuf/CUE: local architecture artifacts pin the quickstart boundary
  so docs and visual consumers can reuse one source of truth.

## Consequences

Docs Portal, Tutorials, Troubleshooting, Launch Site, Workspace UX, Plan/Diff,
and Dashboard work can now cite a common fixture set. They still cannot claim
production publication, customer promises, live credentials, real provider
execution, or enterprise dashboard feature tours from this proof.
