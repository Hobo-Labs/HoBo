# `@hobo/provider-kafka`

First-class **Kafka** (and Kafka-compatible: Redpanda, MSK, Confluent, Azure Event Hubs Kafka protocol) capability provider for HoBo.

Exports **`wasi:messaging`** (and aligned **`hobo:queue`** pull semantics) so Bindle `topic()` / queue authoring stays backend-agnostic. Credentials are **secretless-first** (`fromBinding` / federation / `secretRef` — never plaintext in Resource Definitions).

## Surfaces

| Surface | Role |
|---|---|
| `createKafkaProvider()` | Capability Manifest + `realize()` + messaging factory |
| `createKafkaMessaging()` | Native Kafka-shaped `Messaging` port implementation |
| `createInMemoryKafkaTransport()` | In-memory broker transport for tests and local development |
| `realizeKafkaResources()` | Matching / Resource Definitions → IaC hints |
| `diagnoseKafkaReadiness()` | `hobo doctor` / Gatekeeper readiness |
| `localRedpandaCluster()` | Local defaults for `hobo dev` |

## Fidelity

The in-memory transport and transports without a fidelity declaration report
`simulated`. A caller-supplied transport may declare `fidelity: "live"`; this
is the transport's assertion and does not prove a broker is reachable.
`live: true` requires that declaration. Publish, consume, and metering use the
selected transport and report its declared fidelity.

```ts
import {
  createKafkaMessaging,
  createInMemoryKafkaTransport,
  localRedpandaCluster,
} from "@hobo/provider-kafka";

const bus = createKafkaMessaging({
  cluster: localRedpandaCluster("acme"),
  transport: createInMemoryKafkaTransport(),
});
```

## Authoring

App code uses ports only:

```ts
import { topic } from "@hobo/bindles";
const events = topic("user-created").allow("publish");
```

## Local path

1. Optional: Redpanda on `localhost:9092` (`HOBO_REDPANDA_URL` / `KAFKA_BOOTSTRAP_SERVERS`).
2. Offline tests use `createInMemoryKafkaTransport()` or omit the transport.
3. `hobo doctor` reports Kafka/Redpanda readiness and remediation.

## Secretless

`credentialBindingRef` is required on `KafkaClusterSpec`. Parse rejects plaintext password/API secret fields.

## Permanent non-goals

- Kafka cluster operator / managed-service UI
- Full schema-registry Avro/Protobuf wire protocol (integration points only)
