# Architecture evidence — messaging-dapr-kafka proof

## Schema and constraints

- Protobuf: `architecture/data-models/messaging_proof.proto`
- CUE: `architecture/data-models/messaging_proof.cue`
- PACT: `architecture/pacts/messaging-dapr-kafka.pact.json`

## Parse, don't validate

Parse, don't validate: derived types live in production packages (`@hobo/core` Messaging, Kafka RD parse, Dapr config parse). This proof consumes branded/parsed domain types only — it does not re-validate raw DTOs.

## Event architecture

- **Command** — run native Kafka / Dapr / dual-actor / junction federation scenarios.
- **Event** — messaging.* audit trail; actor.Activated/StateAppended/Passivated under both placements.
- **Actor** — `Order` defineActor under native and dapr hosts.
- **Event store** — adapter-local streams + proof assertions on event types.
- **Materialized view / projection** — folded order total; consumer-group cursors.
- **Snapshot** — none (short streams).
- **Read store** — scenario result records for acceptance map.
