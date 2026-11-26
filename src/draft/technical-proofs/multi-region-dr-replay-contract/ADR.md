# Multi-Region DR Replay Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted restore requests, topology manifests, and replicated log snapshots cross
one parser boundary into derived types (`ParsedRestoreRequest`,
`ParsedMultiRegionTopology`, `ParsedReplicatedLog`). Downstream restore and drill
functions accept only those parsed types.

## Event Architecture

- **Command** — `yard.RestoreRequested` from `hobo yard up --restore <log>`.
- **Event** — `yard.RestoreCompleted`, `projection.Rebuilt`, `actor.Rehydrated`.
- **Actor** — Yard bootstrap actor replays streams and coordinates projection rebuild.
- **Event store** — replicated cross-region log is the durable source of truth for DR.
- **Materialized view / projection** — projections fold replayed streams; integrity is
  verified by byte-identical snapshot comparison (NFR-008).
- **Snapshot** — pre-loss projection snapshots are compared to post-restore snapshots.
- **Read store** — downstream surfaces query the read store for projection snapshots, not the raw event log.

No runtime engine is implemented here; this is a design-time contract naming the
command, event, actor, and projection boundaries for S6-04.
