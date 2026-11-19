# `@hobo/runtime-dapr`

Optional **Camp runtime / component-host adapter** realizing HoBo ports onto **Dapr** building blocks:

| HoBo port / primitive | Dapr realization |
|---|---|
| `ActorHost` / `defineActor` | Virtual actors + placement + reminders |
| `wasi:messaging` / `topic()` | Pub/sub (incl. `pubsub.kafka`) |
| Workflows / steps | **Activity-name mapping only** (permanent non-goal: full engine parity) |

**ADR-0031 stands:** in-process wasm remains the default preferred path. Dapr is **opt-in** via Camp `runtimeRequirements: ["dapr"]` or explicit wiring.

## Fidelity

- No `DaprSidecarClient` → `fidelity: "simulated"`.
- Client injected (`createInMemoryDaprClient` harness or real daprd HTTP client) → `fidelity: "live"`.
- `live: true` without client → throws.

```ts
import {
  createDaprRuntimeHost,
  createInMemoryDaprClient,
} from "@hobo/runtime-dapr";

const bundle = createDaprRuntimeHost({
  tenantId: "acme",
  campId: "prod",
  client: createInMemoryDaprClient(),
});
// bundle.messaging.fidelity === "live"
// bundle.actors.fidelity === "live"
```

Generate Dapr component YAML (no hand-written secrets):

```ts
const yaml = bundle.generateKafkaPubsubYaml("fromBinding:kafka-bootstrap");
```

## Modes

Await messaging `ack` and `nack` directly. A timeout or sidecar failure is an
unknown settlement outcome and blocks another settlement for that delivery in
the adapter instance. `settlementTimeoutMs` sets a positive deadline of at most
30 seconds. The sidecar interface does not carry a provider lease token, so the
host must provide any cross-process fencing and recovery its deployment needs.

The adapter reports `deadLetter: false` and rejects dead-letter topic
configuration. When a subscription handler exhausts its attempts, `subscribe`
throws `MessagingDeliveryExhaustedError` without acknowledging that delivery.
The error includes the lease, the number already handled, and the remaining
leased messages in the batch. The host must decide how to recover or transfer
them; an expired lease can allow redelivery.
Attempt limits depend on the sidecar supplying a durable, accurate delivery
count; the adapter does not persist that count across sidecar restarts.

- **self-hosted:** `dapr run` / local daprd (`HOBO_DAPR_ENDPOINT`)
- **kubernetes:** sidecar injector annotations (control-plane emits; this package generates component YAML)

## Doctor

`diagnoseDaprReadiness()` feeds `hobo doctor`. Absent Dapr → fidelity=`simulated` unless a client is injected.

## Permanent non-goals

- Full Dapr workflow engine parity (activity-name map is the supported surface)
- Every Dapr building block beyond actors + pub/sub messaging
- Replacing the default in-process wasm component-host
