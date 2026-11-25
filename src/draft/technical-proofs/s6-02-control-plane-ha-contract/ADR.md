# S6-02 Control-Plane HA Contract — Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-657.

## Schema And Constraints

- Protobuf shapes: [`architecture/s6_02_control_plane_ha_contract.proto`](./architecture/s6_02_control_plane_ha_contract.proto)
- CUE constraints: [`architecture/s6_02_control_plane_ha_contract.cue`](./architecture/s6_02_control_plane_ha_contract.cue)
- PACT boundary: [`architecture/pacts/s6_02_control_plane_ha_contract.pact.json`](./architecture/pacts/s6_02_control_plane_ha_contract.pact.json)

## Parse, Don't Validate

Untrusted append requests and failover outcomes are parsed once into derived types
(`QuorumFencedAppend`, `LeaderFailoverOutcome`) at the simulation boundary via
[`src/parse.ts`](./src/parse.ts). Downstream assertions consume parsed records — not raw DTOs
with repeated guards.

## Event Architecture

- **Command** — `deploy.*` saga steps and `yard.LeaderElected` singleton commands.
- **Event** — quorum-fenced append records on `control-plane/*` streams.
- **Actor** — ResourceActor / deploy saga coordinator (single-writer per stream).
- **Event store** — quorum-replicated authoritative log; minority partitions cannot commit.
- **Materialized view / projection** — deploy progress fold from stream tail + snapshots.
- **Snapshot** — passivated actor state at latest `seq` before tail replay on failover.
- **Read store** — deploy status and Run Inspector surfaces query the projection, not raw log tails.
- **Fencing** — monotonic `fenceToken` on every append; stale leaders cannot corrupt state.

No production runtime ships here; this names the seams production hardening must preserve.
