---
layout: ../../layouts/Docs.astro
title: Resource catalog
description: "Bindle resource factories grouped as App Kits vs Infra Kits: api, web, service, kv, bucket, queue, and more."
---

# Resource catalog

App resources are declared in **`hobo/bindles`** — the app authoring surface — not in lower-level runtime ports. Names come from record keys the builder returns; explicit Bindle v1 methods do not take resource name arguments.

Resources group as **App Kits** (entrypoint surfaces) and **Infra Kits** (platform resources). Ports and providers link via WIT/WASM ([WASM & WIT](/HoBo/architecture/wasm/)).

## App Kits

Entrypoint-bearing surfaces — [App Kits](/HoBo/primitives/app-kits/). **Session Replay default-on** for each.

| Factory | Role |
|---|---|
| `api` / `web` / `service` / `ui` | HTTP App Kits |
| `websocket` | Realtime Kit |
| `job` | Job Kit |
| `wasm-component` | Component Kit |

## Infra Kits

Port / infrastructure resources — no default Session Replay.

| Factory | Role |
|---|---|
| `kv` / `bucket` | Key-value and object storage |
| `queue` / `topic` | Messaging |
| `secret` | Managed secret resource (residual; prefer secretless) |
| `data` | Portable data dependency (paradigm chosen by Matching) |
| `schedule` | Time-based work |
| `flag` / `auth` / `crypto` / `notify` / `guardrail` / `golden` / `experiment` / … | Cross-cutting catalog |

## Wiring

| Method | Role |
|---|---|
| `.allow()` | Least-privilege capability grants |
| `.with(...)` | Provider-specific optimization escape hatch |
| `connector` | External dependency protocols (e.g. A2A/ACP for agents) |
| `config` / `env` / `secretRef` / `fromBinding` | Config references |

## Lowering

Collection produces provider-agnostic **manifest IR**. Planner lowers nodes to **ResourceIntent** for Matching, cost routing, and DeploymentPlan DAGs.

## What is not a factory

- `search` is not a top-level factory (search extensions are opt-in).
- Topology (`camp`, `yard`, `junction`) is **not** re-exported from bindles.
- Stations/Trails are not Bindle resource factories.

## Related

[Bindles](/HoBo/primitives/bindles/) · [Matching](/HoBo/reference/matching/) · [Config & secrets](/HoBo/reference/config-secrets/) · [Capability map](/HoBo/reference/packages/)
