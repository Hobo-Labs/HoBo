---
type: Reference Standard
title: "OAM — Open Application Model (+ KubeVela)"
description: "Application/Component/Trait/Scope spec for app-centric delivery (KubeVela is the living implementation; wadm speaks an OAM dialect); HoBo maps the vocabulary and renders to wadm, but OAM is never HoBo's model."
tags: [hobo, standards]
---

# OAM (Open Application Model) + KubeVela

> **Standard** · A team-centric application-delivery spec (Alibaba +
> Microsoft, ~v0.3): an **Application** composed of **Components** (workloads)
> configured by **Traits** (operational behaviors) grouped by **Scopes**, with
> platform capabilities registered as **Definitions**. **KubeVela** is the
> CNCF-incubating implementation; **wadm** (wasmCloud) speaks an OAM dialect.
> Sources: oam.dev, github.com/oam-dev/spec, kubevela.io. Fair-use capture.

## What it is

OAM separates concerns by role: developers author Components (what runs),
operators attach Traits (how it behaves operationally — scaling, ingress,
rollout), and platform teams register the vocabulary (ComponentDefinition /
TraitDefinition, in KubeVela backed by CUE templates). An Application is the
single delivery unit binding them. KubeVela adds workflows, policies, and
multi-cluster delivery over that model. Early "run anywhere" ambitions
narrowed in practice to the Kubernetes ecosystem; adoption concentrated in
KubeVela, and wadm reuses the manifest shape for wasmCloud lattices
(spreadscaler/daemonscaler/link traits).

## Key features

- **Role separation as schema** — dev-owned Component vs operator-owned Trait
  is the spec's core insight.
- **Trait** — operational behavior attached declaratively, without touching
  the workload definition.
- **Definitions registry** — platform-extensible vocabulary (CUE-templated in
  KubeVela).
- **Application as delivery unit** — one reviewable object per app per env.

## Relevance to HoBo

**Align-our-model (vocabulary) + render-at-the-boundary (wadm); never the
model.** Pinned by
[ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144) (concept
map; "OAM remains a wadm render target only") and ADR-0108 (manifest IR →
wadm/OAM application manifest; `scaling {min,max}` → spreadscaler; wadm's
link trait ≈ manifest `bind`, per
[competitors/wasmcloud](../competitors/wasmcloud.md#primitive-mapping)). The
concept mapping, now including HoBo's first-class Trait
([ADR-0145](../design/adr/01-architecture-core.md#adr-0145)):

| OAM | HoBo |
|---|---|
| Application | **Bindle** (code-first IR, provider-agnostic, matched not templated) |
| Component | Bindle resource / manifest `component.v1` entry |
| **Trait** | **HoBo Trait** — declaratively attached operational behavior anchored at the manifest `annotations` block (ADR-0145); OAM validated the dev/operator split HoBo enforces via Bindle-vs-Camp/Yard scopes |
| Scope | Camp / Yard / Junction scope objects |
| ComponentDefinition / TraitDefinition | Resource Definitions + capability manifests (Plan 25), CUE-constrained — the KubeVela CUE-template parallel is direct |
| KubeVela workflow/policy | Trails + policy packs + stage-gate |

Divergence kept honest: OAM binds to Kubernetes CRDs and static YAML
composition; HoBo's Application analog is executable TypeScript lowered to a
typed IR, selection is scored Matching with an auditable `match.Decided`, and
the whole model rides an event-sourced control plane. The vision matrix row
([vision](../design/vision.md#plan-17)) scores Score/KubeVela/OAM as
k8s-centric with no AI-native surface.

## Sources

- https://oam.dev / https://github.com/oam-dev/spec — spec (v0.3 core)
- https://kubevela.io — the living implementation
- https://wasmcloud.com/docs/ecosystem/wadm/ — the OAM dialect HoBo renders to
