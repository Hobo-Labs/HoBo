# ADR — messaging-dapr-kafka technical proof

**Status:** Accepted with production packages  
**Related:** [ADR-0138](../../../../docs/design/adr/01-architecture-core.md#adr-0138), [ADR-0031](../../../../docs/design/adr/01-architecture-core.md#adr-0031)

## Decision

Prove production packages (`@hobo/core` Messaging, `@hobo/provider-kafka`, `@hobo/runtime-dapr`) end-to-end with **honest live** client paths:

- Kafka: `createInMemoryKafkaTransport` (or real broker client) → `fidelity: live`
- Dapr: `createInMemoryDaprClient` (or real daprd client) → `fidelity: live`

Simulated mode remains when no transport/client is injected. Never label `live` without one.

## Permanent non-goals

Kafka operator UI · full Dapr workflow engine · advanced schema-registry wire protocols · junction data-plane byte relay.
