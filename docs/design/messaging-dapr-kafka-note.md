---
type: Architecture Note
title: "Messaging, Kafka & Dapr (ADR-0138) — maintenance note"
description: "Pointers for the unified Messaging surface, Kafka capability provider, and optional Dapr Camp runtime introduced in ADR-0138."
tags: [hobo, design, messaging]
---

# Messaging, Kafka & Dapr (ADR-0138)

Maintenance note for the one-shot Messaging plane landing.

## Canonical decision

See [ADR-0138](./adr/01-architecture-core.md#adr-0138).

## Packages

| Package | Role |
|---|---|
| `@hobo/core` | `Messaging` port, parse-don't-validate types, in-memory adapter |
| `@hobo/provider-kafka` | Kafka capability provider, Resource Definitions, doctor |
| `@hobo/runtime-dapr` | Optional Camp runtime (`kind: "dapr"`), ActorHost, pubsub, YAML gen |
| `@hobo/runtime` | `resolveActorPlacement` / `signalActor` |
| `@hobo/junctions` | `deriveMessagingFederationPlan` |
| `@hobo/policy` | `hobo.policy.messaging/v1` pack example |

## Proof

`src/draft/technical-proofs/messaging-dapr-kafka/` — dual-path acceptance map; permanent non-goals listed (not open residuals).

## Fidelity

- Kafka: inject `createInMemoryKafkaTransport()` or a real broker client → `fidelity: live`.
- Dapr: inject `createInMemoryDaprClient()` or a real daprd client → `fidelity: live`.
- Conformance: `runMessagingConformance` against both adapters (`packages/conformance`).

## Permanent non-goals

Kafka operator UI · full Dapr workflow engine · advanced schema-registry wire protocols · junction data-plane byte relay.

## Exercise

```bash
pnpm --filter @hobo/provider-kafka test
pnpm --filter @hobo/runtime-dapr test
pnpm --filter @hobo/conformance test messaging-conformance
pnpm --prefix src/draft/technical-proofs/messaging-dapr-kafka test
# also: pnpm run doctor  (workspace health; messaging is tests + conformance only)
```
