# ADR — `@hobo/provider-kafka`

**Status:** Accepted (ADR-0138)  
**Decision:** Kafka is a first-class capability provider providing a TypeScript messaging client, not an app-level client dependency.

## Context

HoBo apps declare `topic()` over the asynchronous `hobo:durable-messaging` interface. Cloud providers already map topics to SNS/Pub/Sub/Event Grid. Durable log semantics (partitions, consumer groups, exactly-once) need an explicit Kafka-class provider for production messaging and for Dapr `pubsub.kafka` backing stores.

## Decision

1. Ship `@hobo/provider-kafka` as a Matching-selectable capability provider.
2. Provide the TypeScript messaging client; component WIT binding remains unsupported until implemented.
3. Secretless credential brokering only.
4. Local Redpanda / simulated fidelity for offline parity.
5. Metering events on produce/consume.

## Consequences

- (+) Late-bind Kafka ↔ Dapr pubsub ↔ local memory without app changes.
- (+) Exactly-once / transactional flags are capability-gated for can-deploy.
- (−) Full operator/managed-cluster UI out of scope for this package.
