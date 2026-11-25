---
type: Competitive Reference
title: "Spin / Fermyon — competitor reference"
description: "Spin is Fermyon's **open-source framework for building and running event-driven WebAssembly (Wasm) serverless apps** — WASI/Component-Model components declared in a `s"
tags: [hobo, competitors]
competitor:
  slug: spin-fermyon
  name: "Spin / Fermyon"
  aliases: ["spin", "spinkube", "fermyon"]
  primary_category: runtime-substrates
  categories: [runtime-substrates]
  directness: adjacent
  role: "wasm serverless framework and hosts — SpinKube is a HoBo component-host adapter"
  posture: [adopt, render-target]
  hobo_surface: [runtime-portability, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://spinframework.dev/
    - https://www.spinkube.dev/
---

# Spin / Fermyon — competitor reference

> A faithful capture of **Spin / Fermyon** for HoBo competitive analysis. Spin/Fermyon is a **wasm-host landscape adjacent to HoBo**: partly **substrate** — **SpinKube** is an adopted per-Camp `component-host` adapter option ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) — and partly a **PaaS competitor** for wasm apps (**Fermyon Cloud**, **Fermyon Platform for Kubernetes**, **Fermyon Wasm Functions on Akamai**). This file is the **product/PaaS-angle** capture; the **substrate-angle** capture (Wasmtime · Spin/SpinKube · wasmCloud as `component-host` adapters) lives in [`wasm-hosts.md`](wasm-hosts.md). Sources: [spinframework.dev](https://spinframework.dev/) · [spinkube.dev](https://www.spinkube.dev/) · [developer.fermyon.com](https://developer.fermyon.com/) · [fermyon.com](https://www.fermyon.com/) · [CNCF (SpinKube sandbox)](https://www.cncf.io/projects/spinkube/). Spin + SpinKube are **Apache-2.0, CNCF sandbox** projects; Fermyon Cloud / Fermyon Platform for K8s / Fermyon Wasm Functions are commercial (Fermyon was **acquired by Akamai, Dec 2025**, which continues Spin/SpinKube CNCF support). Researched July 2026; API/CLI/manifest shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Spin is Fermyon's **open-source framework for building and running event-driven WebAssembly (Wasm) serverless apps** — WASI/Component-Model components declared in a **`spin.toml`** manifest, triggered by **HTTP / Redis / cron**, with **"NoOps" host APIs** (key-value, SQLite, LLM inference) the host provisions and wires for you. You write a component in any Component-Model language (Rust, JS/TS, Python, TinyGo, C#…), declare its triggers + capability grants in `spin.toml`, then **`spin build && spin up`** to run it locally on a Wasmtime-based host — and **`spin deploy`** (or `spin kube deploy`) to ship it. A "typical Wasm module starts in **~1 ms** (cold start), consumes **~10 MB**, binary **< 5 MB**" — the density/cold-start economics that anchor Spin's whole value proposition.

The mental model is **wasm-as-the-unit-of-compute**: not a container, not a VM, but a sandboxed, deny-by-default WASI component behind a **WIT** contract. Spin is the *framework + local host*; **Fermyon** is the set of **places to run Spin apps**: **Fermyon Cloud** (managed multi-tenant PaaS with NoOps KV + SQLite), **SpinKube** (the CNCF-sandbox, Kubernetes-native way to run Spin apps as native K8s resources via a containerd shim), **Fermyon Platform for Kubernetes** (the commercial layer on SpinKube — self-service, autoscaling, extreme density), and **Fermyon Wasm Functions on Akamai** (edge-serverless on Akamai's network, **GA Nov 2025, benchmarked at 75M RPS**). WASI-http components are **portable across all of these hosts** ("Spin (CLI), Fermyon Cloud, Wasmtime, NGINX Unit, SpinKube…"), which is the one-component-many-hosts thesis HoBo also bets on.

Where HoBo is a **cloud-agnostic control plane + durable runtime** that maps one app onto *any mix of providers*, Spin/Fermyon is a **single wasm host** (and the places to run it). Spin **does not provision cloud infrastructure** — it has no IaC/provider layer; the host supplies managed data (Fermyon Cloud's Turso-backed SQLite/KV). That boundary is the whole story below: Spin/Fermyon is **more mature substrate than HoBo has today** (production wasm hosting, edge at scale, sub-ms cold start), while HoBo adds the **cloud-agnostic provisioning, control-plane planes, event-sourced governance, and AI-native generation** that sit *above* a wasm host — and treats SpinKube as *one adapter behind its `component-host` port*, not the platform.

| Dimension | Spin / Fermyon |
|---|---|
| Authoring | **Wasm components** (WASI / Component Model) declared in **`spin.toml`** + a language SDK |
| Trigger model | **HTTP** (primary), **Redis** pub/sub, **cron**; more (command, MQTT, SQS…) via **trigger plugins** |
| Host APIs ("NoOps") | **key-value store**, **SQLite database**, **LLM inference (Serverless AI)**, relational (MySQL/PostgreSQL outbound), Redis outbound, application **variables**, outbound HTTP |
| Runtime | **Wasmtime**-based wasm host; **~1 ms cold start, ~10 MB memory, <5 MB binary** (vs container ~300 ms / 50–100 MB) |
| Languages | Rust · JS/TS · Python · TinyGo (+ community C#/others) — **any Component-Model language** |
| Local dev | `spin up` runs the app on the local host; local **SQLite/KV** (`.spin/sqlite_db.db`), `spin watch` hot-reload |
| Provisioning / IaC | **none** — Spin does not provision cloud infra; the *host* supplies managed data (e.g. Fermyon Cloud's Turso SQLite/KV) |
| Deploy targets | **Fermyon Cloud** · **SpinKube** (K8s) · **Fermyon Platform for K8s** · **Fermyon Wasm Functions on Akamai** (edge) · self-host (Wasmtime / NGINX Unit) |
| K8s story | **SpinKube** = `spin-operator` + `containerd-shim-spin` (runwasi) + `runtime-class-manager`; Spin apps run as **`SpinApp` custom resources** |
| Density (FP4K) | **>1,500 apps/node** (up to ~5,000), scale-to-zero, sub-ms cold start — "~50× more apps per node" than containers |
| AI | **Serverless AI** — LLM inference host API (`ai_models`, e.g. `llama2-chat`); **no** AI *generation* / agent-identity story |
| License / owner | **Spin + SpinKube: Apache-2.0, CNCF sandbox**; Fermyon Cloud/Platform/Wasm-Functions commercial; **Fermyon acquired by Akamai (Dec 2025)** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Spin application** | A `spin.toml`-declared set of components with triggers |
| **Component** | A WebAssembly component handling a trigger |
| **Trigger** | What invokes a component — HTTP, Redis, cron |
| **Runtime config** | Where backing services (key-value, SQL, vaults) are bound |
| **SpinKube** | The Kubernetes operator running Spin applications as first-class cluster workloads |
| **Fermyon platform** | The commercial/hosted side (Fermyon Cloud, Wasm Functions) |

The mental model is **wasm serverless with near-zero cold start**: a component is instantiated per
request, and because instantiation is sub-millisecond, per-request isolation is affordable in a way
container-per-request never was.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `runtime-portability` | Wasm components running on several hosts, including Kubernetes via SpinKube |
| `extensibility` | Trigger and runtime-config model |

Spin is a **host**, not a control plane: HoBo treats SpinKube as a `component-host` adapter
([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) rather than as a rival, and renders to
it as one target among several.

## Feature surface

### The Spin app — `spin.toml` manifest + components

A Spin application is a **`spin.toml`** manifest (v2) that maps **triggers → components**. A component is a Wasm module plus its capability grants; each declared host capability is **opt-in in the manifest** (deny-by-default). Representative manifest:

```toml
spin_manifest_version = 2

[application]
name = "my-app"
version = "0.1.0"
authors = ["dev@example.com"]
description = "An event-driven Spin app"

[[trigger.http]]
route = "/api/..."
component = "api"

[component.api]
source = "target/wasm32-wasi/release/api.wasm"
allowed_outbound_hosts = ["https://api.example.com"]
key_value_stores = ["default"]      # grant KV access
sqlite_databases  = ["default"]      # grant SQLite access
ai_models         = ["llama2-chat"]  # grant LLM inference
[component.api.build]
command = "cargo build --target wasm32-wasi --release"
```

```toml
# Redis pub/sub trigger — subscribe to a channel
[[trigger.redis]]
address   = "redis://localhost:6379"
channel   = "messages"
component = "on-message"

# Cron trigger — scheduled execution
[[trigger.cron]]
cron_expression = "0 * * * * *"
component       = "cleanup"
```

- **Triggers** are the event sources: **HTTP** (routed by path, the primary trigger), **Redis** (subscribe to a pub/sub channel), and **cron** (schedule). Additional triggers (command, MQTT, SQS…) are delivered as **trigger plugins** — Spin's trigger executor is itself extensible.
- **Components** carry `source` (a local `.wasm` **or** a remote OCI/registry reference with a digest), an optional **`[component.<id>.build]`** (`command`, `workdir`, `watch`), and **capability grants** as manifest fields: `allowed_outbound_hosts`, `key_value_stores`, `sqlite_databases`, `ai_models`, `files`, `environment`, and `variables`.
- **`[variables]`** declares app-level configuration (with defaults / `required`/`secret`) that components read at runtime — the config surface.

### CLI & developer loop

```bash
spin new           # scaffold a new app from a template
spin add           # scaffold a new component into an existing app
spin build         # build all components (runs each [component].build.command)
spin up            # run the app locally on the Spin host
spin watch         # build + run + hot-reload on change
spin registry push # push the app as an OCI artifact to a registry
spin deploy        # deploy (Fermyon Cloud)  |  spin cloud deploy
spin login         # authenticate to the target
spin templates ... # manage component/app templates
spin plugins  ...  # install/uninstall Spin plugins (incl. trigger + kube plugins)
spin kube scaffold # (SpinKube plugin) generate a SpinApp CRD
spin kube deploy   # (SpinKube plugin) deploy to a Kubernetes cluster
```

The loop is **`spin new` → `spin build` → `spin up` (local) → `spin deploy` / `spin kube deploy`**. Locally, the host provides a **local SQLite file** (`.spin/sqlite_db.db`) and a local KV store, so an app using the NoOps data APIs runs unchanged locally and in Fermyon Cloud — "whether you are running on localhost (via `spin up`) or on Fermyon Cloud (via `spin cloud deploy`), not a line of your code needs to change."

### Host APIs (the "NoOps" services)

Spin ships **built-in host capabilities** a component calls through its SDK; access is granted per-component in `spin.toml` and the host provisions the backing store — "developers never have to worry about credentials or connection strings."

- **Key-value store** — `key_value_stores = ["default"]`; the default backend is a local **SQLite** file, swappable to **Redis / Valkey / Azure Cosmos DB** via runtime config. SDK: open a store, `get`/`set`/`delete`/`get-keys`. Instances are per-component across the app.
- **SQLite database** — `sqlite_databases = ["default"]`; relational storage with **no ops** — local `.spin/sqlite_db.db` in dev, a fully-managed **Turso/libSQL** database on Fermyon Cloud, provisioned automatically. SDK: `execute(query, params)` returning rows.
- **LLM inference (Serverless AI)** — `ai_models = ["llama2-chat"]`; the component calls `llm::infer(...)` / `generate_embeddings(...)`. Ships support for **Llama2 Chat** and **CodeLlama Instruct** (13B) plus **`all-MiniLM-L6-v2`** embeddings; on Fermyon Cloud, backed by managed GPUs. This is **inference**, not model provisioning or agent identity.
- **Relational (outbound)** — direct **MySQL / PostgreSQL** outbound from a component (connection-string based), distinct from the NoOps SQLite.
- **Outbound HTTP / Redis** — gated by `allowed_outbound_hosts` (deny-by-default egress); Redis outbound for publish/get/set.
- **Application variables** — `[variables]` + per-component `variables`, with `secret = true` for sensitive values, resolved from the host's config provider (e.g. Vault).

### Deploy targets

- **Fermyon Cloud** — the managed, multi-tenant PaaS: `spin deploy` ships an app, which gets a subdomain, scale-to-zero, and **NoOps managed KV + SQLite** (Turso-backed). Has a **free (Starter) tier** plus paid usage. This is the closest thing to a hosted-PaaS competitor for wasm apps.
- **SpinKube** (CNCF sandbox) — the **Kubernetes-native** way to run Spin. Three sub-projects (contributions from **Microsoft, SUSE, Liquid Reply, Fermyon**): **`spin-operator`** (a controller + the **`SpinApp` CRD** + a `SpinAppExecutor` CRD — deploy Spin apps as *native K8s custom resources*), **`containerd-shim-spin`** (a **runwasi**-based containerd shim so containerd runs Spin apps "just like container workloads"), and **`runtime-class-manager`** (formerly KWasm — installs/updates the shims and the `RuntimeClass` on nodes). A **`spin kube`** CLI plugin scaffolds/deploys the CRD. **This is the adapter HoBo names in [ADR-0031](../design/adr/01-architecture-core.md#adr-0031).**
- **Fermyon Platform for Kubernetes** — the **commercial** layer *on top of* SpinKube: self-service deploy, autoscaling, and **extreme density** — **>1,500 serverless apps per node** (up to ~5,000 with GKE Autopilot), scale-to-zero, sub-ms cold start, "~50× more apps per node" and "7× faster pod scheduling" than container serverless.
- **Fermyon Wasm Functions on Akamai** — **edge-serverless**, **GA Nov 12 2025**: Spin apps distributed across Akamai's global network. Claims **75 million RPS**, **sub-millisecond cold starts**, 99.9% reliability, globally portable across edge/cloud/on-prem. (Akamai then **acquired Fermyon, Dec 1 2025**; co-founders Matt Butcher & Radu Matei joined Akamai's Cloud Technology Group; Spin/SpinKube CNCF support and Bytecode Alliance membership continue.)
- **Self-host** — because Spin apps are portable WASI-http components, they also run on plain **Wasmtime**, **NGINX Unit**, or any compatible host.

### Component Model, WIT & languages

Spin apps are **WebAssembly Component-Model** units behind **WIT** interfaces (the `spin:up` world + `wasi:*` interfaces), so the host↔guest contract is standards-based and language-neutral. SDKs cover **Rust, JS/TS, Python, TinyGo**, with community SDKs for others — any Component-Model language can target Spin. The same **WIT + deny-by-default sandbox + ~1 ms cold start** properties are exactly the substrate facts catalogued in [`wasm-hosts.md`](wasm-hosts.md) and the basis HoBo cites for its own runtime ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).

## Architecture

- **Runtime** — Wasmtime-based, instantiating a component per request and discarding it, which is
  what makes the isolation model affordable.
- **Triggers** — HTTP, Redis and cron dispatch into components.
- **Runtime config** — binds key-value, SQL and secret backends outside the component, so the same
  component runs against different services.
- **SpinKube** — a Kubernetes operator plus a containerd shim, so Spin applications schedule as
  ordinary cluster workloads without a container per component.
- **State authority** — none of its own; the platform or cluster holds it.
- **Portability boundary** — the component is portable; the trigger model and runtime-config schema
  are Spin's, so moving to a different wasm host means re-expressing them.

## Where Spin / Fermyon is stronger

> Shipped, evidenced capability only.

### what Spin / Fermyon does well

- **A mature, production wasm runtime — shipping for years.** This is the honest lead: where HoBo is **design-phase**, Spin/Fermyon **ship real wasm hosting today**. Wasmtime-based, deny-by-default, **~1 ms cold start / ~10 MB / <5 MB binary**.
- **Edge-serverless at genuine scale.** Fermyon Wasm Functions on Akamai is **GA (Nov 2025)** and benchmarked at **75M RPS** with sub-ms cold starts — a production edge story HoBo does not have.
- **Extreme density on Kubernetes.** Fermyon Platform for K8s runs **>1,500 (→~5,000) apps per node** with scale-to-zero — the wasm density economics, realized.
- **CNCF-backed, standards-based, portable.** **Spin + SpinKube are Apache-2.0 CNCF sandbox** projects; SpinKube is co-built by Microsoft/SUSE/Liquid Reply/Fermyon; WASI-http components are **portable across Spin CLI / Fermyon Cloud / Wasmtime / NGINX Unit / SpinKube**.
- **NoOps managed data that actually ships.** KV + SQLite (Turso/libSQL) provisioned and wired by the host, no connection strings — real, and a clean DX.
- **Kubernetes-native via a containerd shim (runwasi).** SpinApps are first-class K8s custom resources scheduled by the existing control plane — reuses the OCI pipeline instead of adding new infra.
- **Clean local↔prod parity for the app author** — `spin up` uses local SQLite/KV so code is unchanged from laptop to cloud.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Spin / Fermyon's limits — HoBo's opening

- **It's a single wasm host, not a meta-cloud.** Spin/Fermyon gives you **one runtime** (and the places to run it); it has **no cloud-agnostic control plane**, no "map one app onto any mix of providers." HoBo treats a wasm host as **one adapter behind a `component-host` port** — SpinKube/wasmCloud/Wasmtime/provider-native are interchangeable per-Camp ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)/[Plan 20](../design/wasm-runtime-wit.md#plan-20)).
- **No provisioning / no IaC layer.** Spin **does not provision cloud infrastructure** — no Pulumi/Terraform/Crossplane, no provider adapters, no "declare a resource and the platform stands it up in *your* account." Managed data exists only where the *host* offers it (Fermyon Cloud's Turso KV/SQLite). HoBo is **cloud-agnostic + IaC-pluggable** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **No control-plane "planes."** No Resource Definitions/Matching ("same app, different infra per environment, auditably"), no cost/budget-aware routing, no contracts/`can-deploy`/policy. HoBo adds **Resource Definitions + Matching + the Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No event-sourced runtime / governance.** No durable actors, workflows, sagas, or replay/audit as a runtime model; the host runs stateless-ish request/response wasm. HoBo's runtime is **event-sourced actors + workflows + choreography sagas over a replayable log** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No cross-host link model of its own.** Spin is HTTP-trigger-centric and single-host; it has **no native cross-host links** (that's wasmCloud's lattice, see [`wasm-hosts.md`](wasm-hosts.md)). HoBo's **links** are late-bound import→export bindings that can span hosts ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0040](../design/adr/01-architecture-core.md#adr-0040)).
- **AI is inference, not generation or identity.** Serverless AI gives an **LLM host API** (`ai_models`); there is **no** AI *generation* pipeline (generate providers/adapters/impls), **no agents-as-principals**, no trainable methods. HoBo's generation pipeline generates the stack ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) and agents carry brokered identities ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **Narrow data paradigm.** KV + SQLite + outbound MySQL/Postgres — no first-class document/graph/vector/OLAP resource in the IfC surface. HoBo formalizes a **paradigm taxonomy + opt-in packages** ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0081](../design/adr/03-data-plane.md#adr-0081)).
- **Value + the managed data plane concentrate in the commercial hosts.** Fermyon Cloud / Platform-for-K8s / Wasm-Functions are the paid layer (and now **Akamai-owned**); the OSS gives you the runtime + SpinKube but not a hosted control plane. HoBo's **Yard is itself a Bindle** — self-host = hosted parity ([Plan 4](../design/control-plane.md#plan-04)) — and monetization is out of design scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Adversarial critique

- **Per-request instantiation shapes what fits.** Stateless request handlers are ideal; long-lived
  connections, in-memory caches, and stateful sessions are awkward or impossible.
- **The trigger set is narrow.** HTTP, Redis and cron cover common cases and leave queues, streams
  and event buses to be reached through other means.
- **Two overlapping ecosystems.** Spin's component model and wasmCloud's overlap heavily while
  differing in wiring philosophy — Spin binds through runtime config, wasmCloud through lattice
  links. A team must choose, and the choice is not obviously reversible.
- **Commercial trajectory has shifted.** Fermyon's hosted offering and packaging have changed
  direction more than once, and adopters should evaluate the current state rather than assume
  continuity; this capture does not assert a specific status.
- **Wasm ecosystem maturity** is the shared constraint across this whole cohort — toolchain support
  varies sharply by language.
- **SpinKube reintroduces Kubernetes** as the operational substrate for teams that adopted wasm
  partly to avoid it.

### Comparisons with adjacent tools

- **vs HoBo:** Spin/Fermyon is a **wasm host + places to run it**; HoBo is a **cloud-agnostic control plane + durable runtime** that *uses* a wasm host (SpinKube among them). Spin is **ahead on the substrate** (mature runtime, edge at 75M RPS, sub-ms cold start, density) — the very properties HoBo's design *assumes*; HoBo is **ahead of the boundary** (provisioning/IaC, control-plane planes, event-sourced governance, AI-native generation). Spin/Fermyon is the clearest evidence that HoBo's **wasm-default bet is sound** *and* the clearest reminder that a runtime alone is not the platform.
- **vs wasmCloud:** both CNCF wasm platforms; wasmCloud adds a **cross-host lattice + WIT links over wRPC/NATS** that Spin lacks, while Spin is more HTTP-app/edge-focused with a slicker single-app DX. HoBo borrows wasmCloud's **links** model and treats **both** as `component-host` adapters (see [`wasm-hosts.md`](wasm-hosts.md)).
- **vs Cloudflare Workers / edge FaaS:** Fermyon Wasm Functions on Akamai is the **standards-based (WASI/Component-Model), portable** answer to a proprietary edge-FaaS runtime — portable across hosts rather than locked to one vendor's isolate. Neither provisions your cloud infra.
- **vs Nitric / Encore (IfC frameworks):** Nitric/Encore **provision cloud resources from code** across clouds/AWS-GCP; Spin **does not provision** — it's a runtime, not an IfC provisioner. HoBo unifies both: a wasm runtime (Spin-like) **+** IfC provisioning across clouds (Nitric/Encore-like) under one control plane.
- **vs Wasmtime:** Wasmtime is the embeddable engine *inside* Spin; Spin adds triggers, the `spin.toml` app model, host APIs, and the deploy targets. HoBo uses Wasmtime as its local/in-container engine too ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).

**Net:** Spin/Fermyon is **the wasm substrate done well and shipping in production** — and it is genuinely **ahead of design-phase HoBo on the runtime itself** (mature host, edge scale, cold-start/density economics). But it stops at the runtime: **no cloud-agnostic provisioning, no IaC, no control-plane planes, no event-sourced governance, no AI-native generation.** HoBo's differentiation is precisely **the system above a wasm host** — and it deliberately *adopts* SpinKube as **one `component-host` adapter** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) rather than competing with the substrate.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Spin / Fermyon concept (✅ has · ➕ goes further · ◐ partial/thin · 🔜 planned). Substrate items HoBo *adopts as adapters*; platform items are HoBo's net-new above the host.

| Spin / Fermyon concept | HoBo equivalent | Notes |
|---|---|---|
| **Wasm components** behind `spin.toml` (WASI / Component Model) | **wasm-default polyglot runtime** — WASI components behind WIT ports ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ✅ same substrate/standard; HoBo's self-hosted default is wasmCloud + a wasm-in-container floor |
| **SpinKube** (K8s-native host: operator + CRD + shim) | **per-Camp `component-host` adapter** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ◐/✅ **adopted as an adapter option** — one host among Wasmtime / wasm-in-container / wasmCloud-lattice / provider-native |
| **Wasmtime** engine inside Spin | local/dev `component-host` + engine inside the wasm-in-container default ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ✅ same engine |
| **`spin.toml`** manifest (triggers → components) | **Manifest IR** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ HoBo IR is provider/IaC-agnostic and carries wiring + **links** + `.allow()` |
| Triggers: **HTTP / Redis / cron** (+ plugins) | `api` / `topic` / `schedule` ports — `wasi:http`•`hobo:http`, `wasi:messaging`, `hobo:scheduler` ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ near 1:1 |
| **Key-value** host API | `wasi:keyvalue` port (kv/cache, [ADR-0118](../design/adr/03-data-plane.md#adr-0118)) | ✅ |
| **SQLite** NoOps database | `hobo:data/relational` (over draft `wasi:sql`, [ADR-0112](../design/adr/03-data-plane.md#adr-0112)); paradigm taxonomy ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)) | ✅/➕ realized onto a per-Camp backend by Matching, not one managed DB |
| **LLM inference** (`ai_models`, Serverless AI) | model/inference **catalog port** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐/🔜 HoBo has the port surface + generation pipeline; a dedicated model-inference port is thinner than Fermyon's shipping Serverless AI |
| deny-by-default wasm sandbox + manifest capability grants | **`.allow()` → three effects** (least-priv IAM + wasm link + agent token) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ one declaration, three effects |
| **Fermyon Cloud** NoOps managed KV/SQLite | **Matching** realizes a port onto a per-Camp backend ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) | ➕ across many clouds + auditable `match.Decided`, not one managed cloud |
| `spin deploy` / `spin kube deploy` | `hobo up` → provider adapters + **pluggable IaC** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ multi-cloud provisioning Spin has no layer for |
| **Fermyon Wasm Functions on Akamai** (edge, 75M RPS, GA) | provider-native / edge `component-host` adapter ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ◐/🔜 adapter slot exists; **Fermyon ships production edge at scale today, HoBo does not** |
| *(none — no provisioning/IaC)* | cloud-agnostic control plane + pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ |
| *(none — single host, no planes)* | Resource Definitions + Matching + **Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ |
| *(none — no event-sourcing/audit)* | **event-sourced** actors + workflows + sagas + replay/audit ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ |
| *(none — Serverless AI is inference only)* | **AI generation pipeline** (generate providers/impls) ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) + **agents-as-principals** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ |
| **Fermyon Cloud / Platform** (commercial, Akamai-owned) | **Yard-is-a-Bindle** self-host = hosted parity ([Plan 4](../design/control-plane.md#plan-04)); monetization out of scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ➕/↔ |

### Spin-as-validation, and the boundary HoBo draws

Spin/Fermyon is **not primarily a HoBo competitor — it's a HoBo dependency-shaped adapter**. Every substrate fact it demonstrates (WASI portability across hosts, deny-by-default capability security, **~1 ms cold start / tiny footprint**, WIT as the contract) is a fact HoBo's runtime design *relies on*, and **SpinKube is written into [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) as an adopted `component-host` adapter**. The competitive overlap is narrow and specific: **Fermyon Cloud** is a hosted PaaS *for wasm apps*, which is the slice where a developer might pick Fermyon Cloud instead of a HoBo Yard. Everywhere else, Spin sits *below* HoBo's line — it is the runtime; HoBo is the control plane, governance, and generation above it.

### The one-line takeaway

**Spin/Fermyon proves — in production — the wasm substrate HoBo bets on, and is ahead of design-phase HoBo on the runtime itself** (mature host, edge at 75M RPS, sub-ms cold start, extreme density). But it is a **single wasm host with no cloud-agnostic provisioning, no IaC, no control-plane planes, no event-sourced governance, and no AI-native generation** — so HoBo **adopts SpinKube as one `component-host` adapter** ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) and differentiates entirely on the system *above* the host: any-cloud + pluggable-IaC provisioning, Resource Definitions/Matching + the Dispatcher, an event-sourced durable runtime, and AI-native generation with agents-as-principals.

## Better-together / integration posture

- **Adopt / render-target** — SpinKube is a `component-host` adapter (ADR-0031); HoBo renders to it.
- **Benchmark** on cold start and on the `spin new` → running loop.
- **Borrow** — **runtime config as the binding seam**: keeping backend selection outside the
  component is the same instinct as wasmCloud links, expressed more simply, and worth studying for
  HoBo's own local development ergonomics.
- Not a displace target.

## Threats and lessons

1. **Wasm hosts are converging on the same shape** — component, trigger, external binding — which
   validates HoBo's substrate bet and makes host choice a genuine portability question. That question
   is exactly what `PortabilityReport` answers, and no wasm-native tooling answers it.
2. **Per-request instantiation is a real architectural advantage** for the workloads it fits, and a
   hard constraint for the ones it does not. HoBo's kinds should make that distinction visible rather
   than hiding it behind "runs anywhere".
3. **Ecosystem fragmentation is the risk to the whole wasm bet.** Two component ecosystems with
   different wiring models split an already-small community.

## Sources

- [spinframework.dev](https://spinframework.dev/) — Spin applications, components, triggers, runtime config
- [spinkube.dev](https://www.spinkube.dev/) — Kubernetes operator and containerd shim
- [fermyon.com](https://www.fermyon.com/) — commercial platform (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Fermyon's current commercial packaging and the Spin trigger catalog
were not re-verified in this pass and are not asserted.
