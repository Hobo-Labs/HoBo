---
type: Competitive Reference
title: "wasmCloud — competitor reference"
description: "wasmCloud is a CNCF WebAssembly application platform — polyglot **components** + **capability providers** linked over a NATS **lattice** via **wRPC**, orchestrated by **wadm** — that HoBo adopts as its default runtime substrate rather than competes with."
tags: [hobo, competitors]
competitor:
  slug: wasmcloud
  name: "wasmCloud"
  primary_category: runtime-substrates
  categories: [runtime-substrates]
  directness: adjacent
  role: "CNCF wasm component runtime (lattice, wRPC, capability providers) — adopted substrate, HoBo's default host"
  posture: [adopt, standard]
  hobo_surface: [runtime-portability, extensibility, typed-contracts]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://wasmcloud.com/docs
    - https://github.com/wasmCloud/wasmCloud
---

# wasmCloud — competitor reference

> **wasmCloud is not a HoBo competitor — it is the runtime substrate HoBo adopts.** A faithful capture of **wasmCloud** (a CNCF **Incubating** project) recorded in the competitors folder because HoBo *builds on* it, not against it. A **self-hosted wasmCloud lattice is HoBo's default component-host** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)), **wRPC is HoBo's membrane** ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)), **capability providers behind WIT ports are HoBo's provider model**, and **links are HoBo's `bind`**. Where the other entries here are rivals, wasmCloud is a **founding pillar** — a shipping runtime that HoBo (still **design-phase**) depends on and extends. Sources: [wasmcloud.com](https://wasmcloud.com/) · [wasmcloud.com/docs](https://wasmcloud.com/docs) · [github.com/wasmCloud/wasmCloud](https://github.com/wasmCloud/wasmCloud) · [CNCF project page](https://www.cncf.io/projects/wasmcloud/) · [wadm](https://github.com/wasmCloud/wadm) · [bytecodealliance/wrpc](https://github.com/bytecodealliance/wrpc). License **Apache-2.0**; CNCF **Sandbox (Jul 2021) → Incubating (Nov 2024)**; created by **Cosmonic**. Researched July 2026; concepts/manifest/CLI shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

wasmCloud is an **open-source, CNCF WebAssembly application platform** that lets teams "build, manage, and scale polyglot apps across any cloud, K8s, or edge." The core model is deliberately small: **components** (portable `.wasm` binaries that hold your stateless business logic) call **capability providers** (swappable host plugins that supply longer-lived capabilities like HTTP, key-value, messaging, blob storage, SQL) through **WIT interfaces** (vendor-neutral contracts), wired together by **links** made at runtime. Those pieces run on a **host** (a runtime node embedding **Wasmtime**), and hosts self-assemble into a **lattice** — "a self-forming, self-healing mesh network that provides a unified, flat topology across any number of environments, clouds, browsers, or even hardware" — over **NATS**. Distributed calls between components and providers travel over **wRPC** ("WIT over RPC"). Applications are described declaratively in **wadm** manifests (Open Application Model YAML) and reconciled to desired state, and the whole loop is driven from the **`wash`** CLI.

The mental model is **components + capabilities, late-bound**. A component *imports* the interfaces it needs (`wasi:keyvalue`, `wasi:http`, …) and never names a concrete backend; the platform *links* those imports to whichever provider is deployed, and "the ability to link components means the capabilities of the wasmCloud host are pluggable and extensible at runtime — you do not need to ship a new host to update or extend capabilities." This is capability-based security by construction: a component can only reach what it has been linked to. That is **exactly the runtime shape HoBo standardizes on** — HoBo's ports are WIT interfaces ([Plan 20](../design/wasm-runtime-wit.md#plan-20)), HoBo's providers are WIT components behind those ports ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)), and HoBo's default host *is* a self-hosted wasmCloud lattice ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)). wasmCloud proves and ships the substrate; HoBo layers provisioning, a control plane, a durable runtime, and an AI-native surface on top of it.

**What wasmCloud is *not*.** It is a **runtime + linking + orchestration** layer for Wasm workloads. It does **not** provision the cloud resources behind its providers (the S3 bucket, the RDS database, the SNS topic), does **not** collect infrastructure from application code (you author manifests + link config by hand), does **not** carry an event-sourced application runtime (actors/workflows/sagas/replay), and does **not** ship an AI generation or agent-identity story. Those are precisely the layers HoBo adds above the wasmCloud substrate — so the relationship is a **superset**, not a rivalry.

| Dimension | wasmCloud |
|---|---|
| Category | **CNCF Incubating** WebAssembly application platform (runtime + lattice + orchestrator) |
| Origin / license | Created by **Cosmonic**; donated to CNCF (**Sandbox Jul 2021 → Incubating Nov 2024**); **Apache-2.0** OSS |
| Unit of code | **Components** — "portable, interoperable WebAssembly binaries that implement stateless logic," per the **W3C WebAssembly Component Model**, targeting **WASI 0.2 (Preview 2)** |
| Capabilities | **Capability providers** — "swappable host plugins … that deliver common functionalities called capabilities": HTTP, key-value, messaging, blob storage, SQL; **built-in** logging/random/clocks form the host's **trusted compute base** |
| Contracts | **WIT** interfaces / **WASI 0.2** worlds (`wasi:http`, `wasi:keyvalue`, `wasi:blobstore`, `wasi:messaging`, `wasi:config`, `wasi:logging`, …) — vendor-agnostic ports |
| Wiring | **Links** — runtime, late-bound connections from a component's *imports* to a provider's/component's *exports*; declared in a manifest or via `wash link` |
| Runtime | **wasmCloud host** node embedding **Wasmtime** (Bytecode Alliance); loads/instantiates/mediates components + providers securely |
| Membrane | **wRPC** ("WIT over RPC") — component-native, transport-agnostic RPC over WIT; default transport **NATS** (also UDS/TCP/QUIC) |
| Network | **Lattice** — self-forming, self-healing, flat topology over **NATS**, spanning cloud/edge/browser with location-independent addressing |
| Orchestration | **wadm** — declarative **OAM** manifests (YAML/JSON), desired-state reconciliation, **spreadscaler**/**daemonscaler** traits, **link** traits |
| Languages | Rust, Go, Python, JavaScript/TypeScript — "and more"; any Wasm-compiling language |
| Tooling | **`wash`** CLI (build/dev/up/app deploy/push/pull/call/link); artifacts distributed as **OCI** images (`ghcr.io/wasmcloud/…`) |
| Kubernetes | **`wasmcloud-operator`** — CRDs (`WasmCloudHostConfig`, …) run hosts + wadm apps on K8s "without … custom nodes"; K8s-secrets integration |
| Not in scope | Cloud-resource **provisioning/IaC**, **infrastructure-from-code** authoring, an **event-sourced app runtime**, **AI generation / agents-as-principals** — the layers HoBo adds |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Component** | The deployable code unit: a WebAssembly component with a WIT-described interface |
| **Capability provider** | A pluggable implementation of a capability (key-value, messaging, HTTP) that components reach through their interfaces |
| **Link** | Runtime wiring between a component and a provider — the binding is a control-plane operation, not a compile-time dependency |
| **Host** | The Wasmtime-based runtime executing components; the trusted compute base |
| **Lattice** | The NATS-backed mesh joining hosts into one location-independent address space |
| **wRPC** | WIT-over-RPC — how a call crosses a host boundary without the caller knowing |
| **wadm** | Declarative application manifests, expressed in OAM vocabulary |
| **wash** | The CLI and local development loop |

The mental model is **deny by default, wired at runtime**: a component can do nothing except what its
imports allow, and what satisfies those imports is decided by a link at deploy time rather than by a
dependency at build time. Late binding of capabilities is the property HoBo's entire portability
argument rests on.

## How it competes with HoBo

wasmCloud is **adopted, not contested**: it is HoBo's default component host
([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)), and `wadm` is a HoBo render target
([ADR-0108](../design/adr/01-architecture-core.md#adr-0108)).

| Surface | Relationship |
| ------- | ------------ |
| `runtime-portability` | Provided by wasmCloud, not competed for |
| `typed-contracts` | WIT is the shared interface language — HoBo's ports are WIT worlds |
| `wiring` | Links are the runtime realization of HoBo's `bind` |
| `extensibility` | Capability providers are one realization path for HoBo's adapters |

The division is clean: **wasmCloud owns the host, HoBo owns the model.** HoBo decides what should
run where and why; wasmCloud runs it and wires it.

## Feature surface

### The component + provider + link model (the substrate HoBo adopts)

wasmCloud treats an application as a composition of **components** and **capability providers** running on interconnected **hosts** within a **lattice**, with **interfaces** defining how entities interact and **links** establishing those interactions. The distinguishing move: *nothing is bound at build time.* A component says "I import `wasi:keyvalue/store`"; a link at runtime targets that import to a concrete provider (Redis, Vault, NATS-KV). Swapping the backing store is a link change, not a code change or a host redeploy. HoBo takes this model wholesale — components-by-default, WIT ports, runtime links — and renames "link" to **`bind`** while adding IAM/token effects on top ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).

### Components (the code unit)

Components are "portable, interoperable binaries (`.wasm` files) that implement stateless logic," holding your business logic while delegating stateful work to providers and the host. They adhere to the **Component Model**, "an open standard governed by the W3C WebAssembly Community Group," and target **WASI P2 (WASI 0.2)** — "a set of standard APIs designed to allow WebAssembly components to access external resources safely and portably." Components "may be compiled from a variety of languages including Rust, Go, Python, JavaScript, and more," built via `wash build` against language toolchains. A component **imports** the interfaces it needs and **exports** functions others can invoke — coupling is by *abstraction* (an interface), never by a concrete dependency.

### Capability providers (the capability plugins)

"Providers are swappable host plugins — executables (usually dedicated to longer-lived processes) that deliver common functionalities called capabilities." They cover functionality outside core business logic — "sending notifications," "fetching secret values," "accessing databases," "serving content over HTTP." External providers ship as **OCI images** in the wasmCloud registry (e.g. `ghcr.io/wasmcloud/keyvalue-redis:0.27.0`), and "to contact a particular provider, a component must be explicitly linked at runtime to the provider." A subset of capabilities is **built-in** to the host (logging, random, clocks) and forms **"wasmCloud's trusted compute base."**

| Capability | WIT / WASI interface | First-party providers (illustrative) |
|---|---|---|
| HTTP (server + client) | `wasi:http` | `http-server`, `http-client` |
| Key-value | `wasi:keyvalue` | `keyvalue-redis`, `keyvalue-vault`, `keyvalue-nats` |
| Blob storage | `wasi:blobstore` | `blobstore-fs`, `blobstore-s3` |
| Messaging (pub/sub) | `wasi:messaging` | `messaging-nats`, `messaging-kafka` |
| SQL database | wasmCloud sqldb | `sqldb-postgres` |
| Config / secrets | `wasi:config` (+ host secrets) | host secrets backends (Vault, K8s, cloud secret managers) |
| Built-in (host) | `wasi:logging`, `wasi:random`, `wasi:clocks` | in-host — the "trusted compute base" |

The full catalog lives on the wasmCloud GitHub Packages page; providers are versioned OCI artifacts, so extending or replacing a capability is a registry + link operation.

### Interfaces: WIT + WASI (the contract)

Interfaces are "contracts that define the relationships between entities like components and providers," giving "vendor-agnostic standards for functionalities such as HTTP or storage." They are expressed in **WIT** (WebAssembly Interface Types); the standardized ones are **WASI 0.2** worlds/interfaces. Because the contract is the interface — not a concrete SDK — a component compiled against `wasi:keyvalue` runs unchanged whether the linked provider is Redis, Vault, or NATS-KV. This is the property HoBo relies on to make ports **provider-portable** and to define *equivalence classes* across clouds ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).

### Links (runtime wiring = HoBo's `bind`)

"The satisfaction of imports and targeting of exports is called **linking**, since the process combines bytecode into applications in a similar fashion to an operating system linker." Links run **from the importer to the exporter** — the importer *targets* the exporter's exposed functions. A component can link to three kinds of entity: **built-in providers** in the host, **other components** (composed at build or connected at runtime), and **external providers**. Links are declared to be made **at runtime** in a deployment manifest, and "wasmCloud will coordinate the links regardless of where the constituent parts are running." A link carries a **namespace / package / interfaces** identifier (e.g. `wasi:keyvalue/store`), a **source**/**target**, and optional **source_config**/**target_config** — and links may be **named** so a component can hold several links on the same interface. HoBo adopts this verbatim as `bind`, then makes one `bind`/`.allow()` declaration produce **three** effects — the runtime link **plus** least-privilege IAM **plus** an agent-token scope ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).

### The host + Wasmtime (the trusted compute base)

"The wasmCloud **host** is a runtime environment node … responsible for loading, instantiating, and communicating among WebAssembly components and providers, in a secure, distributed way." It embeds **Wasmtime**, "a fast, secure, and standards-compliant runtime that supports the Component Model." Each host "subscribes to NATS subjects corresponding to its own responsibilities, as well as lattice-wide subjects," and the design principle is that "the health of the lattice and applications running on it should not be dependent on any particular host." Hosts run built-in providers, mediate every component/provider call, and can be run as a plain binary, in a container, or as pods managed by the Kubernetes operator. A **self-hosted wasmCloud host is HoBo's default Camp component-host** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).

### The lattice + NATS (location-independent mesh)

The lattice is "a self-forming, self-healing mesh network that provides a unified, flat topology across any number of environments, clouds, browsers, or even hardware," built on **NATS**. It is:

- **Self-forming** — hosts discover each other over NATS: "there is no need to deploy complex service discovery products or servers."
- **Self-healing** — it survives "network partition events, partially connected endpoints, and hosts that have slow or high-latency connections" without taking the system down.
- **Flat** — "as long as two endpoints can reach each other — over any number of intervening hops, across any kind of disparate infrastructure — those endpoints can be part of the same lattice," giving **location-independent addressing**: a component doesn't know or care which host its provider runs on.

NATS is the connective tissue: it carries the **wRPC transport**, the **control interface** (queue subscriptions on NATS subjects for exported functions), and — via **JetStream** — **KV buckets** that store wadm application manifests and **streams** for wadm scheduling. NATS is the default (and currently assumed) substrate for the lattice.

### wRPC — WIT-over-RPC (the membrane)

**wRPC** ("WIT over RPC") is "a component-native transport-agnostic RPC protocol and framework based on WebAssembly Interface Types (WIT)" that executes WIT-defined functionality "over network or other means of communication," letting wasmCloud "dynamically link distributed WebAssembly components at runtime." It is a **Bytecode Alliance** project; **wasmCloud uses wRPC for all distributed communication between components and capability providers and was its first reference implementation.** wRPC supports transports including **Unix Domain Sockets, TCP, QUIC, and NATS.io**, and `wrpc-wasmtime` "can be used to polyfill imports at runtime and serve exports using wRPC." Crucially, the wire is *generated from the WIT* — the same contract drives local, cross-process, and cross-lattice calls, with no hand-rolled protobuf/gRPC. **HoBo's membrane is wRPC** ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)): one contract everywhere (a building block is a WIT interface, a provider is a WIT component, the wire is wRPC from that WIT), with conformance as the single trust boundary and no language lock-in for provider authors.

### wadm — declarative application manifests (OAM)

**wadm** (wasmCloud Application Deployment Manager) is a "Wasm-native orchestrator" that "manages declarative application deployments, reconciling the current state of an application with the desired state" — "roughly analogous to a Kubernetes deployment." Manifests follow the **Open Application Model (OAM)** in YAML/JSON: `apiVersion: core.oam.dev/v1beta1`, `kind: Application`, `metadata` (`name`, `annotations`), and `spec.components`. Each component is `type: component` (a Wasm binary) or `type: capability` (a provider), with `properties.image` pointing at a `.wasm`/OCI/`file://` artifact, and **traits**:

- **spreadscaler** — distributes N `instances` across hosts by label, with `spread` rules (`weight`, `requirements`).
- **daemonscaler** — runs instances on *every* matching host (like a Kubernetes DaemonSet).
- **link** — connects a component to a provider or another component (`target`, `namespace`, `package`, `interfaces`, `source_config`/`target_config`).

```yaml
apiVersion: core.oam.dev/v1beta1
kind: Application
metadata:
  name: hello-world
  annotations:
    description: 'HTTP hello world demo'
spec:
  components:
    - name: http-component
      type: component
      properties:
        image: ghcr.io/wasmcloud/components/http-hello-world-rust:0.1.0
      traits:
        - type: spreadscaler
          properties:
            instances: 1
    - name: httpserver
      type: capability
      properties:
        image: ghcr.io/wasmcloud/http-server:0.26.0
      traits:
        - type: link
          properties:
            target: http-component
            namespace: wasi
            package: http
            interfaces: [incoming-handler]
            source_config:
              - name: default-http
                properties:
                  ADDRESS: 0.0.0.0:8000
```

You `wash app deploy` the manifest; wadm validates it, stores it in a NATS/JetStream bucket, and a **scaler** enters a **reconciliation loop** comparing current vs. desired state, issuing lattice commands until status is **Deployed** (matched), **Reconciling** (working toward it), or **Failed**. HoBo's **Manifest IR + Deployment Sets + Matching** ([Plan 25](../design/platform-engineering.md#plan-25)) are the superset of wadm: same declarative, reconciled shape, but with resource *provisioning*, per-environment realization decisions, and cost routing that wadm does not attempt.

### wash — the CLI + dev loop

`wash` (the "WAsm SHell") is wasmCloud's toolchain:

```bash
wash new            # scaffold a component/provider from a template
wash build          # build (and sign) a component or capability provider
wash dev            # developer loop: hot-reload a local component
wash up             # bootstrap a local env (NATS + wasmCloud host + wadm)
wash down           # tear the local env down
wash app deploy     # deploy an application manifest to the lattice
wash app put/get/list/status   # manage manifests
wash push / pull    # OCI registry artifact operations
wash call           # invoke a function on a running component
wash link           # link one component to another on a set of interfaces
wash start/stop/scale          # control component/provider lifecycle
wash inspect        # inspect a component/provider (signing info)
```

`wash up` "establishes the foundational local infrastructure (NATS server, wasmCloud host, wadm)"; `wash dev` gives an iterative loop that "automatically rebuilds and reloads components during active coding." HoBo's `hobo` CLI provides the analogous `dev`/`up`/`deploy` loop ([Plan 7](../design/developer-experience.md#plan-07)), atop the same host.

### Kubernetes: the wasmcloud-operator

wasmCloud runs **on** Kubernetes via the **`wasmcloud-operator`**: "an operator for managing a set of wasmCloud hosts running on Kubernetes and managing wasmCloud applications using wadm," driven by CRDs (hosts via `WasmCloudHostConfig`) so you "tell it which lattice and how many hosts you want" and it reconciles the deployment — "without having to modify your cluster or use custom nodes." It integrates Kubernetes secrets (and cloud backends such as AWS Secrets Manager and Vault). This matters for HoBo: because wasmCloud can sit *on top of* an existing K8s cluster, HoBo can treat **Kubernetes as one provider target** under its pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)) while still presenting the uniform wasmCloud host/lattice above it.

## Architecture

- **Host** — Wasmtime executing components with a capability-based security model; nothing is
  ambient.
- **Lattice** — NATS-based, giving location independence: a component addresses a capability, not a
  host, and the lattice routes.
- **Links** — the control plane sets them; changing a link changes what satisfies an import without
  rebuilding the component.
- **wRPC** — carries WIT-typed calls across hosts, which is what makes the lattice transparent.
- **State authority** — wadm manifests plus lattice state; wasmCloud is a runtime, not a system of
  record.
- **Portability boundary** — genuinely strong at the component boundary and bounded by provider
  coverage: a component is portable, a capability is only as portable as the providers implementing
  it.

## Where wasmCloud is stronger

> Shipped, evidenced capability only.

### what wasmCloud does well

- **Standards-first substrate** — Component Model + WASI 0.2 + WIT give **vendor-neutral, language-neutral contracts**. A component is portable code against an interface, not a framework binding. This is the single most important property HoBo inherits.
- **Runtime-swappable capabilities via links** — capabilities are "pluggable and extensible at runtime — you do not need to ship a new host to update or extend capabilities." Change the backing store/broker by changing a link.
- **Location-transparent, self-healing lattice** — the same app spans cloud, edge, and browser over NATS with location-independent addressing and no bespoke service discovery; it survives partitions.
- **One membrane, one contract (wRPC)** — local, cross-process, and lattice calls all use WIT-generated wRPC; no hand-rolled wire, no language lock-in for provider authors.
- **Polyglot by construction** — any Wasm-compiling language produces a first-class component; capability providers can likewise be written in multiple languages.
- **Declarative, reconciled deployment (wadm)** — Kubernetes-like desired-state orchestration that is Wasm-native, with spread/daemon scaling and link wiring in one OAM manifest.
- **CNCF-governed and OCI-native** — Incubating maturity, open governance, artifacts distributed as ordinary OCI images; a `wasmcloud-operator` brings it to existing K8s estates.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent.

### what wasmCloud leaves to HoBo

These are **not weaknesses** — they are, by design, the layers *above* the runtime substrate that wasmCloud does not attempt and HoBo supplies:

- **No cloud-resource provisioning / IaC.** wadm schedules Wasm components and providers onto hosts you already run; it does **not** provision the S3 bucket, RDS database, or SNS topic a provider talks to, nor generate cloud IAM. HoBo adds **pluggable IaC + multi-cloud provider adapters** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) and `.allow()` → **least-privilege IAM** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **No infrastructure-from-code authoring.** Applications are hand-authored manifests + link config; resources are not *collected from app code*. HoBo adds **IfC collection → Manifest IR** — declare resources inline, run-to-collect, provision ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **No control-plane planes.** No **Resource Definitions + Matching** (same app → different infra per environment, auditably; `match.Decided`), no **cost/Dispatcher** routing, no **contracts / `can-deploy` / policy / governance** planes. HoBo adds these ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033), [ADR-0071](../design/adr/01-architecture-core.md#adr-0071), [Plan 29](../design/contracts-policy-flags.md#plan-29)).
- **No event-sourced application runtime.** The host runs **stateless components** + longer-lived providers; it is not actors, durable workflows, choreography sagas, materialized projections, replay/time-travel, or audit. HoBo adds the **durable event-sourced runtime** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No AI-native surface.** No **agents-as-principals** (identities, token brokering, MCP control), no **AI generation pipeline** for providers/implementations, no trainable functions. HoBo adds agents as principals ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) and a conformance-gated **generation pipeline** ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **NATS operational surface.** The lattice assumes NATS; running, scaling, and securing it is on the operator. HoBo folds the whole substrate into a self-hostable **Yard-is-a-Bindle** so self-host equals hosted parity ([Plan 4](../design/control-plane.md#plan-04)), with commercialization out of design scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Adversarial critique

- **The component model is still maturing.** Toolchain support varies sharply by language, and
  building a component is harder than building a container for most teams today. This is the single
  largest adoption risk HoBo inherits by adopting wasmCloud.
- **NATS is a hard dependency** and an operational surface: the lattice's availability, security and
  scaling characteristics are NATS's.
- **Capability-provider coverage is the practical ceiling.** Late binding is only useful where a
  provider exists for the target; the catalog is far smaller than any container ecosystem.
- **Debugging across the membrane is harder.** A wRPC call that fails between hosts gives less
  context than an in-process call or an HTTP request with a trace header.
- **Ecosystem size.** CNCF governance and real adopters, and orders of magnitude smaller than
  Kubernetes' ecosystem — which matters for hiring, tooling and community answers.
- **Performance characteristics are workload-dependent.** Wasm start-up is excellent; sustained
  compute-heavy or memory-heavy workloads are a different profile from native containers.
- **Adopting a substrate transfers its risk.** HoBo's runtime story depends on wasmCloud's project
  health and on the component model's trajectory, and that dependency should be stated rather than
  assumed away.

### Comparisons with adjacent tools

- **vs Kubernetes / Nomad:** wasmCloud schedules **Wasm components + providers over a lattice**, not containers over nodes — a much lighter, capability-linked unit. It is complementary, not rival: the `wasmcloud-operator` runs wasmCloud *on* Kubernetes, and HoBo treats K8s as one provider target beneath the wasmCloud host.
- **vs Dapr:** both give **portable capability APIs** (Dapr building blocks ↔ WASI/WIT ports) with pluggable components and no provisioning. Dapr is an out-of-process **sidecar** over HTTP/gRPC; wasmCloud is **in-process Wasm** linked over **wRPC**. HoBo unifies both stances — WIT ports (Dapr-like portability) realized on the wasmCloud Component Model (in-process, capability-secure).
- **vs Nitric / Encore:** those are **IfC → provisioned managed cloud** (SDK collects resources, a provider plugin provisions them). wasmCloud is the **runtime + linking substrate *below* that** — it does not provision. HoBo is the composition: **IfC + provisioning (Nitric/Encore-like) authored *onto* the wasmCloud substrate**, so Nitric's "membrane + provider" shape is realized natively as wRPC + WIT components ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)).
- **vs single-node Wasm hosts (Spin, etc.):** wasmCloud's distinguishing asset is the **distributed, self-healing lattice** + runtime links across hosts, versus single-node component execution.
- **vs HoBo:** **not a competitor.** wasmCloud is HoBo's *chosen runtime foundation*. HoBo = **wasmCloud lattice + wRPC + WIT providers/links** (adopted wholesale) **plus** provisioning, control-plane planes, a durable event-sourced runtime, and an AI-native surface (added on top).

**Net:** wasmCloud is the **shipping CNCF substrate HoBo builds on**. HoBo adopts the component/provider/link/host/lattice/wRPC/wadm model essentially unchanged and adds the layers wasmCloud deliberately leaves out — cloud-resource **provisioning + pluggable IaC**, a **control plane** (Resource Definitions/Matching, the Dispatcher, contracts/policy/cost/governance), a **durable event-sourced application runtime**, and an **AI-native** generation + agent-principal surface. It is a **superset relationship, not a rivalry**: wasmCloud is the foundation, HoBo is the meta-cloud built on it.

## Primitive mapping

<a id="hobo-mapping"></a>

> How each wasmCloud concept lands in HoBo. **✅ = HoBo adopts this directly · ➕ = HoBo adds provisioning/control-plane/AI-native on top · ◐ = HoBo adopts and extends · 🔜 = designed but thin/iteration hook.** The founding decision — a **self-hosted wasmCloud lattice is HoBo's default component-host** — is [ADR-0031](../design/adr/01-architecture-core.md#adr-0031); the **wRPC membrane** is [ADR-0069](../design/adr/01-architecture-core.md#adr-0069); the runtime + ports are [Plan 20](../design/wasm-runtime-wit.md#plan-20). HoBo is **design-phase**; wasmCloud is a **shipping CNCF runtime HoBo depends on**.

### Substrate HoBo adopts (mostly ✅)

| wasmCloud concept | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| **Component** (Wasm, stateless, Component Model / WASI 0.2) | Services/components are **Wasm/WASI by default** (OCI container as floor) | ✅ | [20](../design/wasm-runtime-wit.md#plan-20) |
| **WIT + WASI 0.2 interfaces** (vendor-neutral contracts) | HoBo's **canonical port surface** — `wasi:*` + `hobo:*` ports with equivalence classes | ✅ | [20](../design/wasm-runtime-wit.md#plan-20) |
| **Capability provider** (swappable host plugin) | **HoBo provider = WIT component** that exports a building-block interface behind a port | ✅ | [20](../design/wasm-runtime-wit.md#plan-20), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069) |
| **Link** (runtime import→export wiring) | **`bind`** — same late-bound link, *plus* `.allow()` adds least-priv IAM + agent-token scope (one decl, three effects) | ✅/➕ | [21](../design/authoring-resources-wiring.md#plan-21) |
| **wasmCloud host** (Wasmtime node) | **Camp component-host** — a self-hosted wasmCloud host is the default | ✅ | [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) |
| **Lattice** (self-forming NATS mesh) | HoBo's default runtime topology **is** a self-hosted wasmCloud lattice | ✅ | [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) |
| **wRPC** (WIT-over-RPC membrane) | **HoBo membrane** — WIT-generated wire for local/cross-process/lattice, one contract everywhere | ✅ | [ADR-0069](../design/adr/01-architecture-core.md#adr-0069) |
| **Built-in providers** (logging/random/clocks, trusted compute base) | Host-provided WASI capabilities inside the Camp host | ✅ | [20](../design/wasm-runtime-wit.md#plan-20) |
| **`wash` CLI + `wash dev`/`up` loop** | **`hobo`** CLI — `dev`/`up`/`deploy` loop on `runtime-local` + the same host | ◐ | [07](../design/developer-experience.md#plan-07) |
| **`wasmcloud-operator`** (run on K8s) | Kubernetes as a **provider target** under pluggable IaC; wasmCloud host presented uniformly above it | ◐ | [04](../design/control-plane.md#plan-04) |

### Orchestration HoBo adopts and extends (◐ → ➕)

| wasmCloud concept | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| **wadm manifest** (OAM, desired-state reconciliation) | **Manifest IR + Deployment Sets** — same declarative/reconciled shape, superset with provisioning + per-env realization | ➕ | [25](../design/platform-engineering.md#plan-25) |
| **spreadscaler / daemonscaler** (label-based placement/scaling) | Placement + scaling via **Matching** + reliability/cost policies | ➕ | [25](../design/platform-engineering.md#plan-25), [05](../design/reliability-observability-cost.md#plan-05) |
| **link trait** (namespace/package/interfaces + config) | `bind` in the Manifest IR, resolved by Matching to a concrete provider realization | ✅/➕ | [21](../design/authoring-resources-wiring.md#plan-21), [25](../design/platform-engineering.md#plan-25) |
| **NATS/JetStream** (transport, control, manifest store) | Adopted as lattice transport; HoBo's event store/control planes sit above it | ✅/◐ | [ADR-0031](../design/adr/01-architecture-core.md#adr-0031), [11](../design/data-plane.md#plan-11) |

### What wasmCloud leaves to HoBo (➕ net-new above the substrate)

| Capability wasmCloud does **not** provide | HoBo adds | HoBo doc |
|---|---|---|
| Cloud-resource **provisioning + pluggable IaC** (multi-cloud) | Provider adapters + Pulumi/Crossplane/OpenTofu adapters; `.allow()` → least-priv IAM | [04](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006), [21](../design/authoring-resources-wiring.md#plan-21) |
| **Infrastructure-from-code** authoring (collect resources from app code) | IfC collection → Manifest IR (declare inline, run-to-collect, provision) | [21](../design/authoring-resources-wiring.md#plan-21) |
| **Resource Definitions + Matching** (same app → different infra per env, auditable) | `match.Decided` decisions per boundary; recorded and replayable | [25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033) |
| **Cost-aware routing** | The credit/budget-aware **Dispatcher** | [ADR-0071](../design/adr/01-architecture-core.md#adr-0071) |
| **Event-sourced application runtime** (actors/workflows/sagas/replay/audit) | Durable actors + workflows + choreography sagas over a replayable event store | [11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050) |
| **Contracts / `can-deploy` / policy / governance planes** | Policy gates over manifests, deploys, agent actions, conformance | [29](../design/contracts-policy-flags.md#plan-29), [46](../design/governance-planes.md#plan-46) |
| **Agents as first-class principals** (identities, MCP, brokered tokens) | Agent SVIDs + Capability Manifest + MCP control surface | [06](../design/ai-native-agent-auth.md#plan-06) |
| **AI generation pipeline** (generate providers/implementations, conformance-gated) | Forge/SWE loop: stub → implement → trace → auto-evolve (gated) | [23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010) |
| **Self-host = hosted parity** (OSS; monetization out of scope) | **Yard-is-a-Bindle**; commercialization out of design scope | [04](../design/control-plane.md#plan-04)/[ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) |

### Why HoBo adopts wasmCloud (the founding-substrate decision)

wasmCloud already ships the two hardest properties HoBo needs at the runtime layer: a **standards-based, language-neutral component contract** (Component Model + WASI 0.2 + WIT) and a **distributed, self-healing, location-transparent execution fabric** (the lattice + wRPC over NATS). Rebuilding either would be redundant and worse. So HoBo takes them as-is — the **component-host is a self-hosted wasmCloud lattice** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)), the **membrane is wRPC** ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)), **providers are WIT components** and **links are `bind`** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 21](../design/authoring-resources-wiring.md#plan-21)) — and spends its own design budget entirely on the layers wasmCloud omits: provisioning, the control plane, the durable event-sourced runtime, and the AI-native surface.

### The one-line takeaway

**wasmCloud is the runtime substrate HoBo stands on, not a rival to displace.** It ships the component/provider/link/host/lattice/wRPC/wadm foundation HoBo adopts wholesale; HoBo's entire differentiation is the superset built *above* it — multi-cloud provisioning + pluggable IaC, Resource Definitions/Matching + the Dispatcher, contracts/policy/cost/governance planes, a durable event-sourced application runtime, and AI-native generation with agents-as-principals.

## Better-together / integration posture

- **Adopt** — the settled posture: wasmCloud is HoBo's default component host (ADR-0031).
- **Render-target** — HoBo renders manifest IR to `wadm` (ADR-0108), which speaks OAM vocabulary
  shared with KubeVela.
- **Standard** — WIT and WASI are spoken at the boundary, never absorbed as HoBo's internal model,
  per the governing rule in [`lineage.md`](../design/lineage.md).
- Not a displace target in any reading.

## Threats and lessons

1. **HoBo's runtime bet rides on the component model's trajectory.** That is a real, named risk, and
   the mitigation is already architectural: OCI containers remain a fallback and wasmCloud is one
   host among several.
2. **Late binding of capabilities is the mechanism behind HoBo's portability claim.** Links are what
   make "the same component, a different provider" true rather than aspirational — worth stating
   explicitly whenever the portability argument is made.
3. **Provider coverage is the number to watch**, not host features. Portability is bounded by what
   has been implemented, which is exactly what `PortabilityReport` exists to make visible.
4. **Toolchain friction is the adoption blocker.** If building a component is harder than building a
   container, the model's advantages never get evaluated.

## Sources

- [wasmcloud.com/docs](https://wasmcloud.com/docs) — components, capability providers, links, hosts, lattice, wRPC, wadm, wash
- [wasmCloud/wasmCloud](https://github.com/wasmCloud/wasmCloud) — source, CNCF project status
- HoBo-side: [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) (default host), [ADR-0108](../design/adr/01-architecture-core.md#adr-0108) (wadm render target), [`design/lineage.md`](../design/lineage.md)

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current provider catalog size and language toolchain maturity were not
re-verified in this pass and are not asserted.
