---
type: Competitive Reference
title: "Wasm hosting landscape — competitor/grounding reference"
description: "HoBo's runtime substrate ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) is **WASI components behind WIT ports, late-bound by links** — a model HoBo *explicitly borrowed* f"
tags: [hobo, competitors]
competitor:
  slug: wasm-hosts
  name: "Wasm host landscape"
  aliases: ["wasmtime cohort"]
  primary_category: runtime-substrates
  categories: [runtime-substrates]
  directness: adjacent
  role: "cohort capture of the wasm component-hosting landscape grounding ADR-0031 component-host adapters"
  posture: [adopt, render-target]
  hobo_surface: [runtime-portability, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-12
  sources:
    - https://wasmcloud.com/docs/concepts/
    - https://www.spinkube.dev/
---

# Wasm hosting landscape — competitor/grounding reference

> A capture of the **WebAssembly component hosting** landscape — **Wasmtime**, **Fermyon Spin / SpinKube**, and **wasmCloud** — that directly grounds HoBo's most novel infra bet: **wasm-first** with a **`component-host` port** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) and the **links** model ([Plan 20](../design/wasm-runtime-wit.md#plan-20)). Sources: [wasmcloud.com/docs](https://wasmcloud.com/docs/concepts/) · [spinkube.dev](https://www.spinkube.dev/) · [fermyon.com](https://www.fermyon.com/) · WebAssembly Component Model. Excerpts quoted for analysis (see [`index.md`](index.md#sources--fair-use)).

HoBo's runtime substrate ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) is **WASI components behind WIT ports, late-bound by links** — a model HoBo *explicitly borrowed* from wasmCloud — and [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) names **Wasmtime** (local default), **wasm-in-container** (v1 prod default), and **SpinKube / wasmCloud-lattice / provider-native** as the `component-host` adapters. This capture documents those real systems so the decision is grounded, not hand-waved, and stress-tests whether the adapter set holds up.

| Host | Shape | Where it runs | Cross-host links | HoBo role ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) |
|---|---|---|---|---|
| **Wasmtime** | the canonical Bytecode Alliance Component-Model engine (a library/CLI) | embed anywhere (local, in-container, edge) | — (single host) | **local/dev default** + the engine *inside* the wasm-in-container default |
| **Spin / SpinKube** | HTTP-trigger wasm apps; **SpinKube** runs them on K8s via a **containerd shim (runwasi)** | Kubernetes (SpinKube), CLI, Fermyon Cloud | via K8s networking | **k8s-native `component-host` adapter** |
| **wasmCloud** | capability-provider + **lattice** mesh; WIT links over **wRPC/NATS** | any cloud / K8s / edge / browser, as one flat mesh | ✅ **native** (links span hosts on the lattice) | **lattice adapter** (cross-host link migration, [ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) |

Four facts hold across all three, each validating a HoBo design choice. **WASI components are portable across hosts** — "WASI-http components have many compatible hosts — Spin (CLI), Fermyon Cloud, **Wasmtime**, NGINX Unit, SpinKube …" — direct evidence for HoBo's **one component, many `component-host` adapters** thesis. **Capability-based security is the default** — all three rely on wasm's deny-by-default sandbox, the same property as HoBo's `.allow()`→link enforcement ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[Plan 20](../design/wasm-runtime-wit.md#plan-20)). **Cold-start/footprint economics** — "a typical Wasm module starts in **~1 ms** (cold start), consumes **~10 MB**, binary **< 5 MB**, vs a container's ~300 ms / 50–100 MB" — grounds HoBo's "ms cold start, tiny footprint, scale-to-zero" cost/density claims ([Plan 5](../design/reliability-observability-cost.md#plan-05)/[Plan 20](../design/wasm-runtime-wit.md#plan-20)). And **WIT is the contract** across all three — the same standards-based contract HoBo uses for ports ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).

## Feature surface

### Wasmtime — the engine

**Wasmtime** is the canonical Bytecode Alliance Component-Model engine, shipped as a library/CLI you embed anywhere — local, in-container, or at the edge. It is the engine *inside* HoBo's wasm-in-container default and the basis of the local/dev `component-host`. As a single host it has no native cross-host link concept; that comes from the lattice (below).

### Fermyon Spin & SpinKube — wasm on Kubernetes

> Source: [spinkube.dev](https://www.spinkube.dev/) · [fermyon.com/blog](https://www.fermyon.com/blog/introducing-spinkube-fermyon-platform-for-k8s) — summarized for analysis.

**Spin** (Fermyon) is an open-source framework for building/running **event-driven wasm apps**, primarily **WASI-http** (HTTP-triggered) components. Spin apps are portable — "WASI-http components have many compatible hosts — **Spin (CLI), Fermyon Cloud, Wasmtime, NGINX Unit, SpinKube** …" — direct evidence for **one component, many hosts**.

**SpinKube** is "an open-source, Kubernetes-native project that streamlines developing, deploying, and operating wasm workloads in Kubernetes" (Microsoft, SUSE, Liquid Reply, Fermyon). Its three parts:

1. **Containerd Shim for Spin** — uses **runwasi** so **containerd runs Spin wasm apps** in a cluster (wasm alongside containers, same control plane).
2. **Spin Operator** — define Spin wasm apps as **native Kubernetes resources**; orchestrates deployments/pods/services.
3. **Runtime Class Manager** — installs/updates/configures the containerd shims (lifecycle of the wasm runtime class on nodes).

(Plus a **Spin Kube CLI plugin** for scaffold/deploy/inspect.)

For HoBo this validates three things at once: the **SpinKube/containerd-wasm adapter** named in [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) is a real K8s-native `component-host` running WASI components via a containerd shim; the **perf basis** of the cost/density story ("~1 ms cold start, ~10 MB memory, <5 MB binary vs container ~300 ms / 50–100 MB", [Plan 5](../design/reliability-observability-cost.md#plan-05)/[Plan 20](../design/wasm-runtime-wit.md#plan-20)); and the **OCI-container path** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031) v1 default) — running wasm *via containerd* (same registry/scheduler as containers) is precisely HoBo's "wasm-in-container reuses the OCI pipeline, zero new infra" default, of which SpinKube is the K8s expression. Capability-based security by default (deny-by-default sandbox) again matches HoBo's `.allow()`→link enforcement.

Two refinements surface from the analysis. **runwasi/containerd-shim is the concrete mechanism** for both the wasm-in-container default *and* the SpinKube adapter — HoBo's component-host should target **runwasi** as the containerd integration point rather than a bespoke shim. And **Spin is HTTP-trigger-centric**, so the Spin *adapter* covers the HTTP-service slice while Wasmtime/in-container covers non-HTTP ports (queue/actor/workflow) — consistent with the per-Camp adapter model.

### wasmCloud — lattice, capability providers, WIT links

> The system HoBo's **links** model was borrowed from ([Plan 20](../design/wasm-runtime-wit.md#plan-20)). Source: [wasmcloud.com/docs/concepts](https://wasmcloud.com/docs/concepts/) · [linking-components](https://wasmcloud.com/docs/concepts/linking-components/) — summarized for analysis.

**wasmCloud** is a **CNCF** project for building/managing/scaling **polyglot wasm apps across any cloud, K8s, or edge** as one flat mesh. Components and **capability providers** communicate over a **lattice** using **WIT** contracts. Its core concepts:

- **Component** — a wasm Component-Model unit (your business logic), deny-by-default, linking to capabilities it's granted.
- **Capability provider** — delivers a concrete capability (keyvalue, messaging, http, …) for a backend **as a standard WIT interface**. Providers are "external" — standalone entities **on the lattice**, scaled/updated **independently** of any host.
- **Lattice** — a "self-forming, self-healing mesh network … a unified, flat topology across any number of environments, clouds, browsers, or even hardware," letting components/providers/hosts communicate **across infrastructure barriers**.
- **Links** — "the wasmCloud host mediates **runtime links** over the NATS lattice using the **WIT over RPC (wRPC)** protocol." Links are declared in a **manifest**; "you don't have to worry about whether your components are distributed or running on the same host — declare links … and wasmCloud coordinates them regardless of where the parts run." Links can be **same-host or cross-host**.

This is, almost verbatim, HoBo's [Plan 20](../design/wasm-runtime-wit.md#plan-20) model: a **wasmCloud capability provider ≈ HoBo capability provider** (a Provider implementing a WIT interface's exports for a backend); a **wasmCloud link ≈ HoBo link** (late-bound import→export binding; swap the backend with no recompile — Plan 20 literally cites "the wasmCloud model"); and the **wasmCloud lattice ≈ the cross-host substrate** behind HoBo's wasmCloud-lattice `component-host` adapter ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)), whose **cross-host link coordination** is exactly the "migrate late-bound links across hosts without redeploy" capability HoBo attributes to that adapter for failover ([Plan 5](../design/reliability-observability-cost.md#plan-05)) and cross-Camp work ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)).

The analysis surfaces two refinements here too. **wRPC (WIT-over-RPC) is the concrete cross-host link transport** — HoBo's wasmCloud-lattice adapter should adopt **wRPC over the lattice** rather than inventing one (sharpening [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)'s lattice adapter + [ADR-0040](../design/adr/01-architecture-core.md#adr-0040)'s cross-host link migration); **NATS** is the lattice's transport, an operational dependency the adapter inherits (noted, not a blocker). And **providers scale independently of hosts**, validating HoBo treating a provider's runtime impl as separately deployable from the component.

## Differentiators

What separates the three hosts — and where each earns its place as a distinct HoBo adapter:

- **Wasmtime** is an embeddable single-host engine, not a platform: maximum portability, no orchestration or cross-host story of its own. It is the common engine the others build on.
- **Spin / SpinKube** is **HTTP-trigger-centric and Kubernetes-native**: its differentiator is running wasm *as a native K8s workload* through a containerd shim (runwasi), reusing the existing cluster control plane and OCI pipeline rather than adding new infra.
- **wasmCloud** is the only one with **native cross-host links**: a self-forming lattice over wRPC/NATS where links span hosts, providers scale independently, and the topology is one flat mesh across clouds/edge/browser. This cross-host link migration is the capability no single-host engine offers.

Net: each is real and production-grade (wasmCloud is CNCF), they agree on WIT/portability/sandbox/perf, and they cleanly partition into the adapter slots HoBo already named — Wasmtime (local + in-container engine), SpinKube/containerd (k8s-native), wasmCloud lattice (cross-host), provider-native.

## HoBo mapping

> Maps the landscape onto HoBo's `component-host` port + links, and stress-tests whether [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)'s adapter set holds up. Verdict: **it does — validated, with two concrete refinements.**

| Landscape concept | HoBo equivalent | Verdict |
|---|---|---|
| **Wasmtime** (Component-Model engine) | local/dev `component-host` + the engine inside the wasm-in-container default ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ✅ exact match |
| **wasm-in-container via containerd shim (runwasi)** | **v1 prod default** `component-host` (reuses the OCI pipeline) | ✅ validated; pin **runwasi** as the mechanism |
| **SpinKube** (Spin operator + containerd shim + runtime-class-mgr) | **k8s-native `component-host` adapter** | ✅ real system = the named adapter |
| **wasmCloud lattice + capability providers + wRPC links** | **lattice `component-host` adapter** + HoBo **links** / **capability providers** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ✅ HoBo's model *is* this; pin **wRPC/NATS** as cross-host link transport |
| **WIT contracts** across all hosts | HoBo WIT ports ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ✅ same standard |
| **WASI component portable across hosts** | "one component, many `component-host` adapters" ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ✅ directly evidenced |
| **deny-by-default capability security** | `.allow()` → link enforcement ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ✅ same property |
| **~1 ms / ~10 MB cold start** | cost/density + failover-speed claims ([Plan 5](../design/reliability-observability-cost.md#plan-05)) | ✅ numbers grounded |
| *(provider-native wasm targets, e.g. cloud wasm runtimes)* | provider-native `component-host` adapter ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ✅ adapter slot exists |

**Stress-test verdict.** Holds up. Every adapter [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) names corresponds to a real, production system: **Wasmtime** (local + in-container engine), **SpinKube/containerd** (k8s-native), **wasmCloud lattice** (cross-host links + migration), provider-native. The "one component, many hosts behind a `component-host` port" thesis is exactly what WASI-http portability across Wasmtime/Spin/SpinKube/NGINX-Unit already demonstrates.

**Two concrete refinements for HoBo (the analysis payoff).**
1. **Pin `runwasi` (containerd shim) as the integration mechanism** for both the **wasm-in-container default** and the **SpinKube adapter** — don't invent a bespoke shim. *(Sharpens [ADR-0031](../design/adr/01-architecture-core.md#adr-0031).)*
2. **Pin `wRPC` (WIT-over-RPC) over the lattice as the cross-host link transport** for the **wasmCloud-lattice adapter** (and thus for [ADR-0040](../design/adr/01-architecture-core.md#adr-0040)'s cross-host link migration); inherits a **NATS** operational dependency. *(Sharpens [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)/[ADR-0040](../design/adr/01-architecture-core.md#adr-0040).)*

Both refinements are **iteration-hook-level** (no decision reversal). They're recorded here rather than reopening the ADRs, per the "don't churn accepted ADRs for hooks" norm — and noted as Plan 20 iteration hooks.
