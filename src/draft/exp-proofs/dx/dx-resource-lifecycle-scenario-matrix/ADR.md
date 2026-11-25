# ADR: DX resource lifecycle scenario matrix

## Status

Accepted for `HOBO-567`.

## Context

HoBo has detailed resource lifecycle designs across CLI, SDK, API, MCP, planner,
Gatekeeper, ResourceActor, Deployment Set, Delta, import, migration, and
observability documents. The user-facing DX still needs a single branch-sized
contract that says what each caller sees before later packages build UI,
production APIs, or live-provider integrations.

## Decision

Define the resource lifecycle DX as an executable scenario matrix under
`src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix`.

The matrix is the acceptance fixture for downstream resource lifecycle proof
packages. It covers app developer, platform engineer, GitOps, SecOps, DevOps,
SRE, and agent/MCP caller journeys. Each journey must name commands, SDK calls,
API calls, MCP tools, expected artifacts, proof mode, fixture requirements, and
the required happy, blocked, stale evidence, migration/rollback, and support
handoff paths.

The proof uses parse don't validate: raw matrix data crosses
`parseDxResourceLifecycleScenarioMatrix`, which returns a branded parsed object
only after role, path, design-term, and fixture invariants hold. Downstream
consumers receive derived domain types instead of re-checking raw fixture input.

## Architecture notes

- Commands: resource lifecycle operations such as `hobo collect`, `hobo plan`,
  `hobo up`, `hobo inspect`, `hobo logs`, `hobo doctor`, and
  `hobo import terraform`.
- Events: existing design events remain the future runtime source of truth,
  including Gatekeeper decisions, ResourceActor histories, drift events,
  policy decisions, rollback receipts, and `migration.*` previews.
- Actors: ResourceActor is the expected durable execution timeline for
  resource-level state; this proof only names the timeline evidence.
- Event store: accepted events append to the platform event store as the
  replayable source of truth.
- Materialized view / projection: CLI/API/MCP read surfaces consume materialized
  views and projections derived from the event store, and must label stale or
  unknown evidence instead of treating it as success.
- Snapshot: each accepted journey row is a snapshot of the intended projection
  evidence for one role.
- Read store: downstream proof packages read this matrix snapshot and its
  fixture requirements, not a production read store implementation.
- PACT/Protobuf/CUE: local architecture artifacts define the matrix boundary so
  later packages can consume a stable fixture instead of inventing parallel
  journey names.

## Consequences

Later implementation can reuse this fixture when proving CLI, SDK, API, MCP,
dashboard, or support handoff behavior. Visual and production implementation
work remains out of scope until this matrix is consumed by narrower slices.
