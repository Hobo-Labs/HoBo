# Architecture — `@hobo/runtime-dapr`

## Schema and constraints

- Protobuf: [`data-models/runtime_dapr.proto`](./data-models/runtime_dapr.proto)
- CUE: [`data-models/runtime_dapr.cue`](./data-models/runtime_dapr.cue)
- PACT: [`contracts/runtime-dapr-boundary.pact.json`](./contracts/runtime-dapr-boundary.pact.json)

## Parse, don't validate

Parse, don't validate: derived domain types (`DaprRuntimeConfig`, `DaprComponentSpec`) are produced only by `parseDaprRuntimeConfig` / `parseDaprComponentSpec`, which brand tenant-scoped app-ids and reject plaintext secrets in component metadata. Component YAML generation only accepts binding-ref metadata.

## Event architecture

- **Command** — ensure Dapr runtime; acquire actor lease; publish/subscribe via pubsub; register reminder.
- **Event** — `actor.Activated` / `actor.StateAppended` / `actor.Passivated` / `actor.ReminderRegistered` (placement=`dapr`); messaging.* via DaprMessaging; metering `messaging.actor.activate`.
- **Actor** — Dapr virtual-actor placement mapped to single-writer fence tokens.
- **Event store** — per-actor stream in host (fold); Camp EventStore owns control-plane audit.
- **Materialized view / projection** — folded actor state under lease.
- **Snapshot** — none required offline; live may use Dapr state store (declared residual).
- **Read store** — isolation metadata (`dapr_sidecar`, appId).

```
Bindle (topic + defineActor)
        │  TypeScript messaging client and hobo:runtime/actor
        ▼
Camp runtimeRequirements includes "dapr"
        │
        ▼
@hobo/runtime-dapr
  ├─ ActorHost  → Dapr placement (single-threaded per id ↔ lease+fence)
  ├─ Messaging  → Dapr pubsub (component YAML from Resource Definitions)
  └─ Workflow   → partial activity map
        │
        ▼
daprd sidecar  →  components (pubsub.kafka, state.*, …)
        │
        ▼
Backing services provisioned by HoBo Matching/IaC (Kafka, Redis, …)
```

Control plane remains HoBo. Sidecar never receives long-lived secrets — only brokered binding refs + SVID injection (`svidBindingRef`).
