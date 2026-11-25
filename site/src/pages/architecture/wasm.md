---
layout: ../../layouts/Docs.astro
title: WASM & WIT surface
description: "WIT/WASM Component Model: ports as WIT, apps as components, deny-by-default capabilities, and host-supplied storage."
---

# WASM & WIT surface

HoBo’s portability contract is **WIT/WASM** (Component Model / wasmCloud-shaped). TypeScript is the first reference implementation language, not a requirement for the architecture.

**[App Kits](/HoBo/primitives/app-kits/)** (Bindle-declared `api`/`web`/`service`/… surfaces) compose those ports at authoring time. WIT interfaces are the capability boundary the hosts and providers implement.

## Why WIT

| Property | Benefit |
|---|---|
| Typed capability imports | Deny-by-default sandbox is structural |
| Host-supplied storage | Engines swap without guest SQL |
| OCI fallback | Pragmatic packaging where components are not ready |
| Same Bindle, N runtimes | Conformance-tested portability |

## Storage capability

Guests use `hobo:storage@0.1.0` — **not** filesystem paths. Hosts bind SQLite partitions or other engines. See [WIT & storage](/HoBo/reference/wit-storage/).

## Messaging capability

Publish/subscribe is **the messaging port** (`topic()`). Hosts may bind:

- Kafka / Redpanda / MSK via Kafka provider
- Dapr pub/sub via optional optional Dapr runtime (Camp opt-in)
- Local in-memory for offline tests

App code never imports Kafka or Dapr clients. See [Messaging, Kafka & Dapr](/HoBo/reference/messaging/).

## Build

`hobo build` compiles services to components; generated drift fails closed. `hobo stub` keeps contract-backed stand-ins while implementation is generated.

## Isolation dimension

WASM capability security sits beside data / compute / credentials / network isolation. Compromised guest code should not inherit ambient cloud credentials.

## Related

[Architecture](/HoBo/architecture/) · [Messaging, Kafka & Dapr](/HoBo/reference/messaging/) · [Capability map](/HoBo/reference/packages/) · [Security](/HoBo/security/)
