---
layout: ../../layouts/Docs.astro
title: Connectivity & networking
description: "Named endpoints, overlay mesh, pluggable DNS, secretless connectors, env isolation, and Privileged Access Gateway."
---

# Connectivity & networking

Networking in HoBo is **identity-aware and name-first**. Apps dial hierarchical named endpoints; material stays brokered; isolation tiers fail closed.

## Named endpoints

- Pure hierarchical naming (DNS-safe labels, never bare `.hobo`)
- Local: `*.hobo.localhost`
- Overlay: `*.hobo.test`
- **Never** bare `.hobo`

See [Naming reference](/HoBo/reference/naming/).

## Overlay & DNS

Connectivity hosts overlay adapters (Tailscale/Netbird-class), pluggable DNS providers, and Junction dynamic DNS for federation without shared mutable control state.

## Secretless connectors

Workloads use connector plugins (postgres/tcp/mysql/redis, …) that dial **names**. Classical URL+password is residual and audited.

## Isolation & PAM

Environment isolation tiers + optional Privileged Access Gateway sessions. Cross-Station dials need federation grants.

## Local DX

`hobo dev` registers named endpoints; optional portless mode; `HOBO_PORTLESS=0` forces ports. `hobo doctor` reports connectivity hazards.

## Related

[Connectivity reference](/HoBo/reference/connectivity/) · [Security](/HoBo/security/) · [Stations](/HoBo/primitives/stations/)
