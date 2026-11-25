---
layout: ../../layouts/Docs.astro
title: Messaging, Kafka & Dapr
description: "Unified the messaging port / topic() plane: delivery guarantees, Kafka provider, optional Dapr Camp runtime, honest fidelity, and CLI surfaces."
---

# Messaging, Kafka & Dapr

HoBo unifies app messaging behind **ports**, not vendor SDKs. Bindles declare `topic()` / queue / actor `signal`; Camps select backends. **In-process wasm stays the default**. Dapr is **opt-in**.

## Authoring (ports only)

```ts
import { topic } from "hobo/bindles";
// Backend is Matching / Camp runtime selection — never import Kafka or Dapr clients here.
const events = topic("user-created").allow("publish");
```

Actors use the same definition surface under **native** or **dapr** placement.

## Capability map

| Capability | Role |
|---|---|
| Messaging port | Delivery guarantees, tenant scoping, in-memory adapter |
| Kafka provider | Kafka / Redpanda / MSK / Confluent capability + resource definitions |
| Optional Dapr runtime | Optional Camp runtime: ActorHost + pubsub + secretless component YAML |
| Runtime placement | Native or Dapr actor placement and signal routing |
| Junction federation | Cross-Yard topic / actor-signal **federation plan** (control plane + identity) |
| Messaging policy | Exactly-once, deny-Dapr, tenant quotas |
| Conformance suite | Messaging conformance against Kafka and Dapr adapters |

## Fidelity honesty

| Mode | How | Label |
|---|---|---|
| Simulated | No transport / no Dapr client | `simulated` |
| Live harness | In-memory Kafka / Dapr test doubles | `live` |
| Live process | Real broker or daprd client implementing the same interfaces | `live` |
| Forbidden | `live: true` without transport/client | **throws** |

Never treat a boolean flag as live while still on the pure emulator.

## Delivery guarantees

- Portable default: **at-least-once**
- **Exactly-once** / transactional produce are **capability flags** Matching and `can-deploy` can require
- Dead-letter after `maxDeliveryAttempts` (subscription); permanent failure advances the consumer group (commit under lease — do not nack-then-commit)

## Secretless + multi-tenant

- Credentials are binding refs only (`fromBinding`, federation, `secretRef`)
- Generated Dapr component YAML must not embed passwords
- Topics, consumer groups, and Dapr app-ids are tenant-scoped by default

## CLI

| Command | Role |
|---|---|
| `hobo doctor` | Reports Kafka + Dapr readiness and messaging hazards |
| Authoring | Declare `topic()` in the Bindle; backends are Camp/Matching choices |

Messaging plane diagnostics surface through `doctor` and contract/conformance suites — apps never import Kafka or Dapr clients.

## Permanent non-goals

- Kafka cluster operator / managed-service UI
- Full Dapr workflow **engine** parity (supported: **activity-name map only**)
- Advanced schema-registry Avro/Protobuf wire protocol end-to-end
- Junction **data-plane** byte relay (control-plane federation is in; overlay carries data)

## Related

[ActorHost](/HoBo/reference/actor-host/) · [Queue](/HoBo/reference/queue/) · [Component hosts](/HoBo/reference/component-hosts/) · [Capability map](/HoBo/reference/packages/) · [CLI](/HoBo/reference/cli/) · [WASM & WIT](/HoBo/architecture/wasm/)
