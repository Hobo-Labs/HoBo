---
layout: ../../layouts/Docs.astro
title: Connectivity
description: "Overlay mesh, pluggable DNS, named endpoints, secretless connectors, isolation tiers, PAM, and metering sinks."
---

# Connectivity

**Connectivity** is the multi-tenant networking foundation: hierarchical naming consumers, overlay (Tailscale/Netbird-class), pluggable DNS, policy-aware isolation, secretless connector plugins, and metering sink hooks.

## Subsystems

| Area | Role |
|---|---|
| **Naming** | Builds on pure naming helpers; registers local/overlay endpoints |
| **Overlay** | Mesh membership for `.hobo.test` style reachability |
| **DNS** | Memory, public managers (Route53/Cloudflare adapters), Junction dynamic DNS |
| **Secretless connectors** | postgres/tcp/mysql/redis (+ registry) — workloads dial **names**, not material |
| **Isolation tiers** | Env isolation classes; fail closed across tiers without grant |
| **PAM** | Privileged Access Gateway sessions (also Station-aware) |
| **Metering** | Sinks for connectivity-adjacent usage facts |
| **Tenancy** | Soft multi-tenant context enforcement helpers |

## Secretless connectors

| Rule | Detail |
|---|---|
| Workload dials | Named endpoint only |
| Material | Brokered by identity/connectivity — never ambient long-lived keys in app |
| Protocols | Plugin registry (postgres, tcp, mysql, redis, …) |
| Residual | Classical URL+password only via explicit residual path + audit |

## Isolation

Hard environment isolation and optional **Privileged Access Gateway** bound who can reach what. Cross-Station Connection use fails closed without federation grant (Station package owns occupancy; connectivity enforces dial policy).

## Local DX

- Named endpoints + optional portless mode for `hobo dev`
- `HOBO_PORTLESS=0` forces classic ports
- Connectivity host handler serves local registration without cloud DNS

## What not to do

- Invent bare `.hobo` hosts
- Pass provider secrets into wasm guests “for convenience”
- Pool free-tier network allowances across tenants

## Related

[Naming](/HoBo/reference/naming/) · [Security](/HoBo/security/) · [Identity](/HoBo/reference/identity/) · [Stations](/HoBo/primitives/stations/)
