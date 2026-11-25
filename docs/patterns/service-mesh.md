---
type: Reference
title: "Service mesh (Istio / Linkerd / Envoy) — Pattern Reference"
description: "Sidecar/ambient service-mesh pattern: mTLS, L7 policy, traffic shifting, telemetry at the network layer — and how HoBo deliberately replaces it with the WIT membrane, links, and optional mesh adapters."
tags: [hobo, patterns]
---

# Service mesh (Istio / Linkerd / Envoy)

> **Pattern** · Transparent L4-L7 infrastructure between services: mutual TLS,
> identity, authorization, retries/timeouts, traffic splitting, and telemetry
> injected at the network layer (classically via Envoy sidecars; lately
> ambient/sidecar-less modes). Reference implementations: Istio (Envoy xDS),
> Linkerd (Rust micro-proxy), Consul Connect. Sources: istio.io, linkerd.io,
> envoyproxy.io. Factual surface quoted under fair use.

## What it is

A mesh interposes proxies on every service-to-service hop so that security
(mTLS, SPIFFE-shaped identity), reliability (retries, timeouts, circuit
breaking, outlier detection), traffic management (weighted shifting, canary,
mirroring), and observability (uniform metrics/traces) become platform
concerns configured declaratively, instead of per-app library code. Istio
generalizes this over Envoy's xDS APIs; ambient mode moves L4 into a
per-node ztunnel with optional L7 waypoints; Linkerd trades generality for a
minimal Rust proxy.

## Key features

- **Zero-trust service identity + mTLS everywhere**, typically SPIFFE IDs.
- **Declarative traffic policy** — weighted routing, canary, fault injection.
- **Uniform resilience** — retries/timeouts/circuit breakers outside app code.
- **Uniform telemetry** — per-hop metrics/traces without instrumentation.
- **The cost**: per-hop proxies, config sprawl, and a second control plane to
  operate — the operational burden ambient modes exist to reduce.

## How HoBo realizes (or deliberately replaces) it

HoBo takes the mesh's *goals* and relocates them; the mesh itself is an
**optional adapter, never the model**
(ADR-0143 non-goals; [ADR-0143 non-goals](../design/adr/07-portability-extensibility.md#adr-0143):
no Istio/Envoy xDS/Linkerd/Gateway API types in `@hobo/core`):

- **Identity/mTLS** → SPIFFE-shaped workload identity and token brokering are
  first-class in the identity plane
  ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) — same SVID idea, no
  per-hop proxy required.
- **The interposition point** → where a mesh interposes on network hops, HoBo
  interposes on **WIT links** (the membrane, ADR-0069): calls cross a typed
  boundary the platform already mediates, so policy/telemetry attach at the
  link, not a packet proxy.
- **Traffic shifting/canary** → the TrafficRouting port + offerings ladder
  (ADR-0143) and the Harness/OpenDelivery rollout engine — provider-native or
  in-process weighted routing, with `mesh.optional` as a declared offering
  when a real mesh adapter is registered.
- **Resilience** → visible, contract-attached `ResilienceProfile`
  (ADR-0136) instead of invisible proxy-level retries — retries a reviewer can
  see, and never for terminal decisions.
- **Telemetry** → OTel at boundaries ([standards](../standards/otel-otlp-genai-openinference.md)).
- **Connectivity across networks** → the overlay `mesh` port (WireGuard/
  [Tailscale](../technologies/tailscale.md), ADR-0122) — L3 reachability,
  deliberately separated from L7 policy.

The borrowed lesson, credited plainly: the mesh proved that identity,
resilience, traffic policy, and telemetry belong to the **platform**, not app
code. HoBo keeps that thesis and rejects the sidecar tax by owning a typed
call boundary (links) where a mesh only owns packets. Dapr's sidecar
([competitors/dapr](../competitors/dapr.md)) sits between: building-block APIs
over a sidecar; HoBo's answer to both is the membrane.

## Sources

- https://istio.io/latest/docs — concepts (traffic, security, ambient)
- https://linkerd.io/2/overview — minimal-proxy stance
- https://www.envoyproxy.io/docs — xDS data plane
