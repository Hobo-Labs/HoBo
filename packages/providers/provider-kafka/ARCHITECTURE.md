# Architecture — `@hobo/provider-kafka`

## Schema and constraints

- Protobuf: [`data-models/provider_kafka.proto`](./data-models/provider_kafka.proto)
- CUE: [`data-models/provider_kafka.cue`](./data-models/provider_kafka.cue)
- PACT: [`contracts/provider-kafka-boundary.pact.json`](./contracts/provider-kafka-boundary.pact.json)

## Parse, don't validate

Parse, don't validate: derived domain types (`KafkaClusterSpec`, `KafkaTopicResource`) are produced only by `parseKafkaClusterSpec` / `parseKafkaTopicResource` / `parseKafkaResourceDefinition`, which reject plaintext credential fields at the boundary. Delivery guarantees parse through `@hobo/core` `parseDeliveryGuarantee`.

## Messaging — event architecture

- **Command** — realize Kafka cluster/topic Resource Definitions; publish/consume on the Messaging port.
- **Event** — `messaging.topic.created`, `messaging.published`, `messaging.consumed`, `messaging.acked`, `messaging.delivery.exhausted`, metering `messaging.publish` / `messaging.consume`.
- **Actor** — none owned here; actor placement is Runtime (`native` | `dapr`).
- **Event store** — messaging audit log on the adapter; control-plane facts join Camp EventStore.
- **Materialized view / projection** — consumer-group cursor (acked + inflight leases).
- **Snapshot** — optional schema-registry ref only (no payload snapshot).
- **Read store** — partition-aware log for consume (simulated offline; live brokers when wired).
