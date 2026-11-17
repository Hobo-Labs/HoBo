# Messaging, Kafka, and Dapr proof

The proof exercises the native Kafka messaging adapter and the optional Dapr
messaging and actor paths using in-memory transports. It checks tenant-scoped
topics, publish and consume behavior, actor fencing, component YAML, and
federation planning. It does not establish connectivity to a Kafka broker or a
Dapr sidecar.

Parse, don't validate: the production adapters return parsed domain types for
configuration and messaging names. Actor commands append events through the
selected host; reading actor state returns a materialized view. The in-memory
fixtures use local event stores and do not provide durable snapshots or a
separate read store.

Run the proof and its production dependencies with:

```bash
pnpm --filter @hobo/provider-kafka test
pnpm --filter @hobo/runtime-dapr test
pnpm --prefix src/draft/technical-proofs/messaging-dapr-kafka test
```

The proof does not implement a Kafka cluster operator, a full Dapr workflow
engine, advanced schema-registry wire protocols, or a federation byte relay.
