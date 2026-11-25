---
type: Competitive Reference
title: "Identity, Networking & Application Delivery — category index"
description: "Category index: Identity-aware networking, secretless connectivity, ADC/gateway, mesh, exposure, and auth-broker systems."
tags: [hobo, competitors, category]
---

# Identity, Networking & Application Delivery

> Category index. Full research lives in each canonical capture — see [`../metadata-contract.md`](../metadata-contract.md) for why this page carries rows, not research.

## Category boundary

Identity-aware networking, secretless connectivity, ADC/gateway, mesh, exposure, and auth-broker systems.

## Why HoBo competes here

HoBo's connectivity and identity ports must be credible against dedicated products; most are integration or provider targets rather than rivals.

## Competitors (6)

| Competitor | Role in this category | Directness | Contested HoBo surface | Competitor advantage | HoBo distinction | Posture | Priority |
| ---------- | --------------------- | ---------- | ---------------------- | -------------------- | ---------------- | ------- | -------- |
| [**NetScaler**](../netscaler.md) *(primary)* | application delivery controller plus its IaC surface — candidate gateway provider and hobo-import analog | complementary | `governance`, `identity-secrets` | Enterprise-grade L4-L7 delivery with a real config-to-IaC migration path. | HoBo's gateway port abstracts ADC behaviour; NetScaler is a provider target and an import-tooling lesson. | provider-target, borrow | P3 |
| [**shoo.dev**](../shoo.md) *(primary)* | zero-config Google sign-in auth broker (PKCE + ES256/JWKS) — identity integration target | complementary | `identity-secrets` | Genuinely zero-config sign-in with standards-based PKCE/JWKS. | HoBo's identity port covers workload and agent identity, not just human sign-in. | integrate, provider-target | P3 |
| [**ServerKit**](../serverkit.md) | self-hosted open-source server control panel with a Go agent fleet — node-attach/Relay reference | adjacent | `delivery`, `observability`, `identity-secrets` | Complete self-host control panel including mail, WAF, backups and an agent fleet. | HoBo's node-attach path is contract-driven and auditable rather than panel-driven. | benchmark, borrow | P3 |
| [**Control Plane**](../control-plane.md) | multi-cloud virtual-cloud runtime — the shipped product closest to HoBo's portability claim, solved at the runtime and identity layer rather than the manifest layer | direct | `runtime-portability`, `provider-matching`, `environments`, `identity-secrets`, `app-graph` | Portability that works: GVCs span AWS/Azure/GCP and BYOK clusters, with credential-free Universal Cloud Identity and a global/location/internal mTLS endpoint scheme. | Control Plane makes workloads portable by owning the runtime, so the portability ends at its edge; a Bindle deploys through the provider's own services and survives HoBo's absence. | displace, benchmark, borrow, provider-target | P1 |
| [**Tailscale**](../tailscale.md) *(primary)* | identity-keyed overlay network — an adopted adapter, and the strongest working demonstration that identity, not address, should determine reachability | complementary | `identity-secrets`, `runtime-portability`, `governance` | Removes network configuration as a category: identity-keyed WireGuard mesh across NAT and firewalls, ACL grants reviewed like code, and tailnet lock bounding the vendor's own authority. | HoBo places and describes applications; Tailscale is an opt-in adapter behind the mesh port under ADR-0122's WireGuard floor, never the portability boundary. | adopt, provider-target, borrow, benchmark | P2 |
| [**NetBird**](../netbird.md) *(primary)* | self-hostable identity-keyed overlay — the adapter that makes HoBo's air-gapped and sovereign connectivity story credible | complementary | `identity-secrets`, `runtime-portability`, `governance` | Every component open source and self-hostable, coordination plane included, with explicit custody claims: the private key never leaves the machine and neither Signal nor Relay can read traffic. | Different layer: HoBo evaluates residency and placement independently of an overlay that is designed to make location irrelevant. | adopt, provider-target, borrow | P2 |

## Navigation

- [All categories](index.md) · [corpus index](../index.md) · [cross-category matrix](../matrix.md) · [gap analysis](../gap-analysis.md)
