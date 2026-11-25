# Data Plane Reference Architecture

The reference architecture composes the Data Plane epic into a single vertical slice:

1. A typed domain event body is compiled from a WIT-record fixture and round-tripped through the protobuf wire contract.
2. A CQRS command appends `order.Placed` through the mocked EventStore boundary.
3. The projection fold proves replay/live equivalence and feeds both Reactor and GraphQL facade reads.
4. Projection sink decisions stay behind mocked relational/document/native boundaries and expose `data.Changed`.
5. Search remains the query side of data: in-core full text is reactive, vector/graph extensions run as steps, and local embed keeps air-gapped Camps in boundary.
6. Adversarial behavior fails closed: projection lag is labeled, divergent snapshots rebuild from zero, poison events emit quarantine facts, auth/flag read-set changes repush, and crypto-shred erasure tombstones forgettable fields.

## Boundary Map

| Boundary | Consumer | Provider | Mock strategy | Notes |
|---|---|---|---|---|
| EventStore append | CQRS aggregate runtime | Camp EventStore | Pact fixture + in-memory command runtime | Exactly-once effect over expected seq. |
| Projection sink | Projection engine | Relational/document/native sinks | Deterministic sink summaries | Change-feed emits `data.Changed`. |
| Subscription gateway | Reactor | Gateway/Streamer | Captured push collector | Monotonic per-stream seq vector. |
| GraphQL facade | Snapshop client | Materialization snapshot facade | In-memory GraphQL runtime | Tenant and scope checked before read. |
| Search/embed | Search materialization | Full-text/vector/embed providers | In-memory search and local embed fixtures | Vector/graph stay off reactive path. |
| Governance/erasure | Privacy projection | Governance/erasure service | Crypto-shred POC keyring/log | Erasure appends tombstones, never rewrites prior events. |

## Deferred Provider Work

Provider-side Pact verification is deferred until real EventStore, sink, gateway, GraphQL, search, and governance services exist. This PR pins the consumer-driven interactions and mocked provider strategies so later provider work can verify against the same inventory.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
