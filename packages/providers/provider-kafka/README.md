# `@hobo/provider-kafka`

First-class **Kafka** (and Kafka-compatible: Redpanda, MSK, Confluent, Azure Event Hubs Kafka protocol) capability provider for HoBo.

Exports **`wasi:messaging`** (and aligned **`hobo:queue`** pull semantics) so Bindle `topic()` / queue authoring stays backend-agnostic. Credentials are **secretless-first** (`fromBinding` / federation / `secretRef` — never plaintext in Resource Definitions).

See [ADR-0138](../../../docs/design/adr/01-architecture-core.md#adr-0138).

## Surfaces

| Surface | Role |
|---|---|
| `createKafkaProvider()` | Capability Manifest + `realize()` + messaging factory |
| `createKafkaMessaging()` | Native Kafka-shaped `Messaging` port implementation |
| `createInMemoryKafkaTransport()` | Live-path broker harness (same methods as a real client) |
| `realizeKafkaResources()` | Matching / Resource Definitions → IaC hints |
| `diagnoseKafkaReadiness()` | `hobo doctor` / Gatekeeper readiness |
| `localRedpandaCluster()` | Local defaults for `hobo dev` |

## Fidelity

- **No transport** → `fidelity: "simulated"` (pure in-process Messaging).
- **Transport injected** (harness or real broker client) → `fidelity: "live"`; all produce/fetch/commit go through the transport.
- **`live: true` without transport** → throws (never labels live falsely).

Await `ack` and `nack` directly. The live adapter bounds each settlement to
30 seconds by default; `settlementTimeoutMs` may choose a shorter positive
deadline. A timeout or transport failure leaves the outcome unknown and blocks
another settlement for that delivery in this adapter instance. The broker
transport and host remain responsible for cross-process fencing and recovery.

The adapter reports `deadLetter: false` and rejects dead-letter topic
configuration. If a subscription handler exhausts its delivery attempts,
`subscribe` throws `MessagingDeliveryExhaustedError` without acknowledging
the failed delivery. The error includes its lease, the number already handled,
and any remaining leased messages in the batch. The host must decide how to
recover or transfer them; a lease may expire and allow redelivery.
Attempt limits depend on the transport supplying a durable, accurate delivery
count; the adapter does not persist that count across transport restarts.

```ts
import {
  createKafkaMessaging,
  createInMemoryKafkaTransport,
  localRedpandaCluster,
} from "@hobo/provider-kafka";

const bus = createKafkaMessaging({
  cluster: localRedpandaCluster("acme"),
  transport: createInMemoryKafkaTransport(), // live client path
});
// bus.fidelity === "live"
```

## Authoring

App code uses ports only:

```ts
import { topic } from "@hobo/bindles";
const events = topic("user-created").allow("publish");
```

## Local path

1. Optional: Redpanda on `localhost:9092` (`HOBO_REDPANDA_URL` / `KAFKA_BOOTSTRAP_SERVERS`).
2. Offline tests use `createInMemoryKafkaTransport()` for the live path or omit transport for simulated.
3. `hobo doctor` reports Kafka/Redpanda readiness and remediation.

## Secretless

`credentialBindingRef` is required on `KafkaClusterSpec`. Parse rejects plaintext password/API secret fields.

## Permanent non-goals

- Kafka cluster operator / managed-service UI
- Full schema-registry Avro/Protobuf wire protocol (integration points only)
