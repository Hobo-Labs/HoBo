# Messaging + Dapr + Kafka technical proof

**ADR-0138** proof: unified Messaging surface, native Kafka capability provider (honest live transport), optional Dapr Camp runtime / ActorHost dual placement, junction topic federation.

## Acceptance criteria map

| # | Criterion | Evidence |
|---|---|---|
| 1 | Native Kafka path | Live transport tests + conformance (`native-kafka-live`) |
| 2 | Dapr sidecar path | Live client tests + conformance (`dapr-pubsub-live`) |
| 3 | Actor model parity | dual fixture native vs dapr in `test/e2e.test.ts` |
| 4 | Unified authoring | no Kafka/Dapr imports in app-shaped examples — only ports |
| 5 | Secretless + multi-tenant | parse rejects secrets; tenant-scoped topics/app-ids |
| 6 | Cross-cloud | `deriveMessagingFederationPlan` (control-plane + identity) |
| 7 | Local/prod parity & doctor | doctor/messaging command tests; fidelity honest |
| 8 | Conformance & gates | `runMessagingConformance` vs Kafka + Dapr adapters |
| 9 | Event-sourced audit | messaging.* + actor lifecycle events asserted |
| 10 | Docs complete | ADR-0138 + this README |
| 11 | No regression | production package unit tests |
| 12 | Production-ready core | live client paths proven; open residuals demoted to non-goals |

## How to exercise

```bash
pnpm --filter @hobo/core build
pnpm --filter @hobo/provider-kafka test
pnpm --filter @hobo/runtime-dapr test
pnpm --filter @hobo/conformance test messaging-conformance
pnpm --prefix src/draft/technical-proofs/messaging-dapr-kafka test

# Live harness without real brokers (injectable transports):
# HOBO_KAFKA_LIVE_TRANSPORT=memory → resolveKafkaTransportFromEnv
# HOBO_DAPR_LIVE_CLIENT=memory → resolveDaprClientFromEnv

# Composition surfaces (when @hobo/hobo deps resolve):
# hobo doctor
# hobo messaging status|realize|component-yaml
```

### Live vs simulated fidelity (honest)

| Mode | How | Fidelity label |
|---|---|---|
| Simulated | no transport/client | `simulated` |
| Live harness | `createInMemoryKafkaTransport` / `createInMemoryDaprClient` injected | `live` |
| Live process | real Redpanda/daprd client implementing the same interfaces | `live` |
| Forbidden | `live: true` without transport/client | throws |

### Example Bindle shape (ports only)

```ts
import { topic } from "@hobo/bindles";
const events = topic("user-created").allow("publish");
```

Camp opt-in to Dapr:

```ts
camp("polyglot", {
  bindle,
  runtimeRequirements: ["dapr"],
});
```

## Architecture

```mermaid
flowchart TB
  subgraph authoring
    T[topic / wasi:messaging]
    A[defineActor]
  end
  subgraph native
    K[@hobo/provider-kafka]
    TR[KafkaBrokerTransport]
    R[Redpanda / MSK / harness]
  end
  subgraph dapr_opt [optional]
    D[@hobo/runtime-dapr]
    C[DaprSidecarClient]
    S[daprd / harness]
  end
  T --> K --> TR --> R
  T --> D --> C --> S
  A --> D
  A --> NativeHost[native ActorHost]
```

## Permanent non-goals (not open residuals)

These are **out of product scope** for ADR-0138 production readiness:

- Full production Kafka cluster operator / managed-service UI
- Full Dapr workflow **engine** parity (supported surface is **activity-name mapping only**)
- Advanced schema-registry Avro/Protobuf wire protocol end-to-end
- Junction **data-plane** byte relay for federated topics (control-plane + identity federation is in; overlay carries data)
- Replacing ADR-0031 in-process wasm default with Dapr

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/messaging-dapr-kafka test
pnpm run architecture:guard
pnpm run draft:artifacts -- src/draft/technical-proofs/messaging-dapr-kafka
```
