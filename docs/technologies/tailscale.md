---
type: Reference
title: "Tailscale — Technology Reference"
description: "WireGuard-based zero-config mesh VPN (tailnets, MagicDNS, Funnel, ACL grants); HoBo's adopted managed-overlay adapter behind the mesh port."
tags: [hobo, technologies]
---

# Tailscale

> **Technology** · WireGuard-based zero-config mesh VPN: identity-keyed
> "tailnets", NAT traversal via DERP relays, MagicDNS, public exposure via
> Funnel, policy via ACL grants. Sources: tailscale.com/kb, github.com/tailscale.
> Factual surface quoted under fair use for interoperability analysis.

## What it is

Tailscale builds a private WireGuard mesh ("tailnet") between machines with
almost no configuration: devices authenticate against an identity provider,
exchange keys through a coordination server, and get stable 100.x addresses +
MagicDNS names. NAT traversal falls back to encrypted DERP relays. **Funnel**
exposes a local service to the public internet through Tailscale's edge;
**Serve** shares within the tailnet. ACLs are declarative JSON ("grants")
keyed on users/groups/tags. `tsnet` embeds a userspace node in a Go process;
subnet routers and exit nodes bridge non-Tailscale networks. Headscale is the
self-hosted coordination-server alternative; Netbird the OSS product analog.

## Key features

- **Zero-config mesh**: identity login → keys → flat private network; no
  firewall holes, no static IPs.
- **Funnel / Serve**: one-command public or tailnet-scoped exposure of a local
  port, TLS handled at the edge.
- **Tagged nodes + grants**: machine identity via tags; ACL policy file
  reviewed like code.
- **tsnet**: embed a node in-process — apps join the mesh without an agent.
- **DERP**: relayed fallback so connectivity is not hostage to NAT topology.

## Relevance to HoBo

**Opt-in managed-mesh adapter (behind the `mesh` port).** ADR-0122
([portability-extensibility](../design/adr/07-portability-extensibility.md#adr-0122))
selects **WireGuard as the portable default floor**; Tailscale is one of the
opt-in, only-registered-considered managed-mesh adapters (Netbird as the
self-hosted alternative; Headscale noted for sovereign Yards) — selection is
per-Junction config, recorded, deny-by-default. Note: the shipped
`@hobo/connectivity` config currently defaults to the tailscale adapter and
has no WireGuard-floor adapter yet — tracked as a GAPS.md finding. The **Funnel**
traffic-routing adapter (`packages/connectivity/src/traffic-routing/funnel.ts`)
declares `overlay.funnel` / `overlay.funnel.multi` offerings in the ADR-0143
fallback ladder. Junction overlay realization
([security-networking](../design/security-networking.md#plan-12)) composes the
same substrate. What HoBo borrows conceptually: **identity-keyed networking**
(nodes join by identity, not address — congruent with SPIFFE workload
identity), **policy-as-reviewable-file** (congruent with policy packs), and
**zero-config developer expectation** for cross-Yard connectivity. Boundary
kept honest: Tailscale is an adapter behind ports — the coordination plane is
a third-party dependency, so air-gapped/sovereign Yards (ADR-0036) use
Headscale/Netbird or no overlay at all; the mesh is never the portability
boundary.

## Sources

- https://tailscale.com/kb — product docs (tailnets, Funnel, grants, tsnet)
- https://github.com/tailscale/tailscale — OSS client/daemon
- https://github.com/juanfont/headscale — self-hosted coordination server
