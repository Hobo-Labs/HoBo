---
layout: ../../layouts/Docs.astro
title: WIT & storage
description: "hobo:storage@0.1.0 host capability, component isolation, no SQL across the boundary, and relation to SQLite default engines."
---

# WIT & storage

HoBo’s programmable surface is **WIT/WASM** (Component Model). TypeScript is the first reference language, not the only runtime. Storage for components is a **host-supplied capability**, not “open a file path from guest code.”

## `hobo:storage@0.1.0`

| Rule | Detail |
|---|---|
| Surface | WIT capability bound by the host |
| Guest sees | Engine-neutral storage operations aligned with EventStore semantics |
| Guest must not see | SQL dialects, filesystem paths, driver pragmas |
| Host implements | SQLite partition, future remote adapters, in-memory test fakes |

Conformance tests prove guests behave identically across hosts that implement the WIT.

## Why capability-shaped storage

1. **Move cheap** — swap host engine without rewriting app components.
2. **Deny-by-default sandbox** — WASM capability security is a structural isolation dimension.
3. **Air-gap friendly** — host can bind in-boundary storage only; no egress required for durability.

## Related WIT surfaces (experimental / evolving)

| Interface | Role |
|---|---|
| `hobo:storage` | Event/journal durability |
| `hobo:secrets` | Residual secrets store bridge |
| Runtime WIT ports | Broader Camp capabilities as they stabilize |

Stability tags on port descriptors (`stable` | `preview` | `experimental`) apply — do not treat experimental WIT as frozen.

## Coupling to engines

SQLite is the **default host engine**, not the public portability boundary. Apps and components depend on ports/WIT; operators choose engines that pass the conformance suite.

## Build path

`hobo build` compiles services to wasm components with OCI fallback. Drift between declared contracts and generated artifacts fails closed.

## Related

[Capability map](/HoBo/reference/packages/) · [EventStore](/HoBo/reference/eventstore/) · [Architecture](/HoBo/architecture/) · [WASM guide](/HoBo/architecture/wasm/)
