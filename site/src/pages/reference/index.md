---
layout: ../../layouts/Docs.astro
title: Reference overview
description: "Technical reference for HoBo ports, contracts, effects, identity, connectivity, CLI, events, and errors."
---

# Reference overview

This section is the **lookup manual** — precise product surfaces for implementing, reviewing, or debugging. Narrative learning stays in the [Guide](/HoBo/guide/); testing patterns live under [Testing](/HoBo/testing/).

## Map

| Page | Use when you need |
|---|---|
| [Capability map](/HoBo/reference/packages/) | Which product surface owns a concern |
| [Component hosts](/HoBo/reference/component-hosts/) | How components run vs how the journal is stored |
| [EventStore & journal](/HoBo/reference/eventstore/) | Durable log, positions, fencing, SQLite default |
| [Schema & migrations](/HoBo/reference/schema/) | Journal schema and integrity |
| [Queue](/HoBo/reference/queue/) · [Streamer](/HoBo/reference/streamer/) · [Clock](/HoBo/reference/clock/) | Other Camp ports |
| [Messaging](/HoBo/reference/messaging/) | Topics, delivery guarantees, Kafka / Dapr options |
| [ActorHost & fencing](/HoBo/reference/actor-host/) | Leases and fence tokens |
| [Runtime ports](/HoBo/reference/runtime-ports/) | Port coupling summary |
| [Contracts & Gatekeeper](/HoBo/reference/contracts/) | Compatibility and deploy gates |
| [Effects & resiliency](/HoBo/reference/effects/) | Side-effect intent and resiliency profiles |
| [Policy plane](/HoBo/reference/policy/) | Packs, obligations, deny ceilings |
| [Matching & ResourceActors](/HoBo/reference/matching/) | Placement + reconciliation |
| [Harness & progressive](/HoBo/reference/harness/) | Flags, experiments, lanes |
| [Errors & codes](/HoBo/reference/errors/) | Stable machine codes |
| [Event families](/HoBo/reference/events/) | Canonical event names |
| [CLI surface](/HoBo/reference/cli/) | Canonical verbs |
| [WIT & storage](/HoBo/reference/wit-storage/) | Component storage capability |
| [Identity](/HoBo/reference/identity/) · [Naming](/HoBo/reference/naming/) · [Connectivity](/HoBo/reference/connectivity/) | Identity + network |
| [Config & secrets](/HoBo/reference/config-secrets/) · [Metering](/HoBo/reference/metering/) | Secretless config + usage facts |
| [Session Replay](/HoBo/reference/session-replay/) | Session reconstruction on every App Kit |
| [Glossary](/HoBo/reference/glossary/) | One-line definitions |

## Status honesty

Pre-release: some capabilities are design-stage only. [Trail map](/HoBo/guide/status/) lists what runs today.
