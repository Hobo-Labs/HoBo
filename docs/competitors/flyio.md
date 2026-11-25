---
type: Competitive Reference
title: "Fly.io — competitor reference"
description: "Fly.io is a **developer-first public cloud / PaaS** that runs your app as **Firecracker microVMs** (\"Fly Machines\") on **its own hardware** across global regions, fronted by a **global A"
tags: [hobo, competitors]
competitor:
  slug: flyio
  name: "Fly.io"
  aliases: ["fly"]
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms]
  directness: overlapping
  role: "global app platform on Firecracker microVMs — edge PaaS competitor and provider target"
  posture: [provider-target, benchmark]
  hobo_surface: [environments, runtime-portability, delivery]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://fly.io/docs/
    - https://fly.io/docs/machines/
---

# Fly.io — competitor reference

> A faithful capture of **Fly.io** for HoBo competitive analysis, treated **as a PaaS competitor** — distinct from Fly's incidental appearance as a raw-provider *seed* in HoBo's provider list ([`control-plane.md`](../design/control-plane.md#plan-04) lists Fly as a `CloudProvider` for "global app/VM hosting · volumes" via Terraform/Pulumi). Fly is a **shipping developer cloud** with genuinely strong tech — **Firecracker microVMs** (Fly Machines), a **global Anycast network + `fly-replay`**, a clean **Machines REST API**, and **LiteFS** edge-SQLite — that HoBo (design-phase) has **not** matched on real global-edge runtime, microVM isolation, or hardware footprint. The contrast is orthogonal: Fly is **single-platform** (its own runtime, its own network, its own hardware); HoBo is a **multi-cloud meta-cloud** that maps one app description onto any mix of providers — with Fly itself as one target. Sources: [fly.io](https://fly.io/) · [fly.io/docs](https://fly.io/docs/) · [Machines API — docs.machines.dev](https://docs.machines.dev/) · [`fly.toml` reference](https://fly.io/docs/reference/configuration/) · [flyctl](https://fly.io/docs/flyctl/) · [architecture](https://fly.io/docs/reference/architecture/) · [LiteFS](https://fly.io/docs/litefs/) · [Managed Postgres](https://fly.io/docs/mpg/) · [`fly-replay`](https://fly.io/docs/networking/dynamic-request-routing/) · [Fly GPUs](https://fly.io/docs/gpus/) + ["We Were Wrong About GPUs"](https://fly.io/blog/wrong-about-gpu/) · [Fly Kubernetes](https://fly.io/docs/kubernetes/) · [Tigris](https://fly.io/docs/tigris/) · [Upstash](https://fly.io/docs/upstash/redis/) · [pricing](https://fly.io/docs/about/pricing/). Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Fly.io is a **developer-first public cloud / PaaS** that runs your app as **Firecracker microVMs** — branded **Fly Machines** — on **hardware Fly owns and operates** in regions worldwide, fronted by a **global Anycast network**. You describe the app in a single **`fly.toml`**, ship it with **`fly launch`** / **`fly deploy`** (the **`flyctl`** / **`fly`** CLI), and Fly builds a container image (Dockerfile or buildpacks), provisions Machines, public IPs, volumes, and TLS certs, and starts the app close to your users. Unlike Encore/Nitric/HoBo it is **not** infrastructure-from-code and **not** multi-cloud — Fly *is* the cloud: your workload runs on **Fly's runtime, Fly's network, and Fly's hardware**.

The mental model is **"VMs as an API."** The platform (**Apps v2**, the current Machines-based platform that replaced the earlier Nomad-orchestrated Apps v1) is built around the **Machines REST API** at `api.machines.dev`: a Machine is a Firecracker microVM you can create, start, stop, and destroy in **sub-second** time, billed **per second**, that can **scale to zero** (stop) and **auto-start on the next request**. Everything else — `flyctl`, Fly Kubernetes, and third-party tools — sits on top of that primitive. A **Rust proxy (`fly-proxy`)** on every edge server terminates TLS, matches Anycast connections to the nearest healthy Machine, and forwards over a **WireGuard "backhaul" mesh** between datacenters; the **`fly-replay`** header lets an app re-route a whole request to another region, Machine, or app.

Fly's data + AI surface is a mix of **first-party** and **integrated third-party** services: **Fly Volumes** (zone-local NVMe), **Managed Postgres (MPG)** (new, fully-managed) alongside the legacy self-run **Fly Postgres**, **LiteFS** (distributed SQLite), **Tigris** (S3-compatible global object storage), **Upstash** (serverless Redis/Vector), and **Fly Kubernetes (FKS)**. Notably, Fly is **exiting the raw-GPU business**: per ["We Were Wrong About GPUs"](https://fly.io/blog/wrong-about-gpu/), **Fly GPUs are deprecated as of July 31, 2026** ("unavailable after August 1") — the AI-infra bet is being wound down toward "developers want LLM APIs, not GPU instances."

| Dimension | Fly.io |
|---|---|
| Category | **Developer-first public cloud / PaaS** — runs your app on Fly's own hardware |
| Runtime | **Firecracker microVMs** ("Fly Machines"); OCI container images; sub-second boot, per-second billing, scale-to-zero + auto-start |
| Authoring | Hand-authored **`fly.toml`** + Dockerfile/buildpacks (**not** infrastructure-from-code; no `.allow()` model) |
| Control surface | Imperative — **`flyctl`/`fly` CLI** + the **Machines REST API** (`api.machines.dev/v1`) |
| Networking | **Global Anycast** (BGP) + Rust **`fly-proxy`** + **WireGuard backhaul** + **`fly-replay`** request routing; regions on six continents |
| Data | **Fly Volumes** (zone-local NVMe) · **Managed Postgres** (new) / legacy **Fly Postgres** (self-run) · **LiteFS** (distributed SQLite) · **Tigris** (S3-compat object) · **Upstash** (Redis/Vector) |
| Compute extras | **Fly Kubernetes (FKS)** (K3s + Virtual Kubelet, closed beta) · **GPUs** (A10/L40S/A100) — **deprecated 2026-07-31** |
| Portability | **Single-platform** — "your container runs anywhere *Fly* has hardware"; no other clouds, no pluggable IaC |
| License / price | Proprietary SaaS; **usage-based, per-second** billing, **no free tier** (legacy orgs keep old allowances); support Standard **$29/mo** → Enterprise **from $2,500/mo** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **App** | The deployable unit, declared in `fly.toml` |
| **Machine** | A Firecracker microVM — the actual runtime primitive, individually addressable and startable |
| **Region** | One of many global locations an app's machines can occupy |
| **Anycast IP** | The global address that routes a request to the nearest healthy machine |
| **Volume** | Region-pinned persistent storage attached to a machine |
| **Fly Postgres / managed data** | Data services colocated with the compute |

The mental model is **machines placed close to users**: the platform's primitive is a microVM you can
start, stop and place explicitly, and the network routes to whichever one is nearest. This is a
lower-level, more honest abstraction than most PaaS products offer — Fly exposes placement rather
than hiding it.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `runtime-portability` | Firecracker microVMs run ordinary containers globally, with fast start |
| `provider-matching` | **Placement is explicit and user-controlled** — the same decision HoBo scores, exposed as configuration |
| `environments` | Apps and regions as deployment scopes |
| `delivery` | `fly deploy` with machine-level rollout control |

Fly.io is the corpus's clearest example of *placement as a first-class user concern*, which is HoBo's
territory approached from the runtime side rather than the modelling side.

## Feature surface

### Fly Machines — the Firecracker microVM core

A **Fly Machine** is a **Firecracker microVM** (KVM hardware virtualization — the same microVM technology AWS built for Lambda/Fargate). Fly reports **sub-second** boot and full VM lifecycle control. Machines are **billed per second**; an app is a set of Machines fronted by `fly-proxy`. With `auto_stop_machines`/`auto_start_machines` (below), idle Machines **stop (scale to zero)** and **auto-start on the next request** — Fly's answer to serverless without giving up a full VM. Compute comes as **shared-CPU** (cores shared across tenants) or **performance** (dedicated cores) presets (`shared-cpu-1x`, `performance-2x`, …), with independently-sized RAM. Isolation is **per-Machine** (per-microVM), a real multi-tenant hardware boundary — a genuine strength HoBo has not proven.

### `fly.toml` — the app configuration

One TOML file per app; `fly deploy` renders it into Machine config. Documented top-level keys: `app`, `primary_region`, `kill_signal`/`kill_timeout`, `console_command`, `swap_size_mb`, `[build]`, `[deploy]`, `[env]`, `[http_service]`, `[[services]]`, `[[vm]]`, `[[mounts]]`, `[checks]`, `[processes]`, `[metrics]`, `[[statics]]`, `[[files]]`, `[experimental]`. Representative shape:

```toml
app = "my-app"
primary_region = "iad"

[build]

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080          # default 8080
  force_https = true
  auto_stop_machines = "stop"   # "off" | "stop" | "suspend"
  auto_start_machines = true
  min_machines_running = 0      # scale-to-zero when 0
  [http_service.concurrency]
    type = "requests"           # or "connections"
    soft_limit = 200
    hard_limit = 250

[[vm]]                          # compute preset per process group
  size = "shared-cpu-1x"
  memory = "512mb"
  cpu_kind = "shared"           # "shared" | "performance"
  cpus = 1
  # gpu_kind = "l40s"           # (GPUs deprecated 2026-07-31)

[[mounts]]                      # attach a Fly Volume
  source = "data"               # volume name
  destination = "/data"
```

The `[processes]` block defines multiple process groups (e.g. `app`, `worker`) from one image; `[[vm]]`, `[[mounts]]`, and services can be **targeted per process group**. `[[statics]]` serves files straight from the proxy. `fly.toml` is **hand-authored config**, not declarations collected from application code — the antithesis of the IfC model HoBo/Encore/Nitric use.

### `flyctl` / `fly` — the CLI

`flyctl` (invoked as `fly`) is the primary interface: create/deploy apps, manage Machines, volumes, secrets, networking, and certs. Representative commands:

```bash
fly launch                       # scaffold fly.toml + create app (--no-deploy to hold)
fly deploy                       # build image → push → provision Machines/IPs → release
fly machine run|start|stop|list|clone|destroy   # granular per-Machine control
fly volumes create data --region iad --size 10
fly postgres create              # legacy self-run Postgres app (Stolon/repmgr)
fly mpg create                   # Managed Postgres (fully managed)
fly secrets set KEY=value        # encrypted, injected at runtime
fly scale count 3 | fly scale vm shared-cpu-2x
fly regions add ord nrt          # add regions to the app
fly extensions ...               # provision Tigris / Upstash / Sentry (third-party)
fly status | logs | ssh console | proxy | ips list | certs add example.com
```

### Machines API — VMs as a REST resource

All requests hit **`https://api.machines.dev/v1`** with **`Authorization: Bearer <token>`**; the spec is published as OpenAPI. Resources: **Apps, Machines, Volumes, Secrets, TLS Certificates, Tokens**. Core Machine operations:

```
POST   /v1/apps/{app}/machines                    # create (returns a booting microVM)
GET    /v1/apps/{app}/machines                     # list
GET    /v1/apps/{app}/machines/{id}                # get
POST   /v1/apps/{app}/machines/{id}                # update
POST   /v1/apps/{app}/machines/{id}/start|stop|suspend
GET    /v1/apps/{app}/machines/{id}/wait           # block until a target state
DELETE /v1/apps/{app}/machines/{id}                # destroy
POST   /v1/apps/{app}/machines/{id}/lease          # cooperative locking (also GET/DELETE)
POST   /v1/apps/{app}/machines/{id}/cordon|uncordon
# create body: { image, guest:{cpu_kind,cpus,memory_mb}, env, services, restart:{policy,max_retries} }
#   restart.policy ∈ { "no" | "on-failure" | "always" }
```

This is Fly's real differentiator as a *primitive*: a fast, minimal API for fast-booting VMs that others (FKS, third-party platforms, agent sandboxes) build on.

### Networking — Anycast, regions, `fly-proxy`, `fly-replay`

Fly announces global IP blocks from every datacenter over **BGP (Anycast)**; clients reach the nearest edge, where the Rust **`fly-proxy`** terminates TLS and routes to the closest healthy Machine — over the **WireGuard backhaul** if the Machine is elsewhere. Apps deploy to **regions on six continents** (docs region codes include `iad`, `ord`, `sjc`, `lax`, `ewr`, `dfw`, `yyz`, `lhr`, `ams`, `fra`, `cdg`, `arn`, `nrt`, `sin`, `syd`, `gru`, `bom`, `jnb`). The **`fly-replay` response header** lets an app tell the proxy to replay the *whole request* elsewhere:

```
fly-replay: region=sjc                    # send to a region
fly-replay: region="iad,ord,us,na"        # comma-list must be quoted
fly-replay: instance=00bb33ff             # a specific Machine  (also prefer_instance=)
fly-replay: app=target-app                # another app in the org (router / FaaS pattern)
fly-replay: elsewhere=true                # exclude the responding Machine
# plus timeout= / fallback= for error handling
```

The canonical pattern: read replicas serve locally, and **writes are `fly-replay`'d to the primary region** — the same idea LiteFS relies on. This is a **shipping, production global-edge runtime**; HoBo's equivalent is design-phase.

### Data & storage

- **Fly Volumes** — persistent **local NVMe** attached to a single Machine, provisioned per region. **Zone-local** (not network-attached): HA/replication is the app's problem. `$0.15/GB/month` of provisioned capacity; snapshots `$0.08/GB/month` (first 10 GB free).
- **Fly Postgres (legacy)** — famously **"not a managed database"**: an app *you* run (a Machine running Postgres + Stolon/repmgr). You are the DBA — backups, failover, upgrades are yours.
- **Managed Postgres (MPG)** — the newer, **fully-managed** service: automatic backups/recovery, **HA with automatic failover**, monitoring, scaling, connection pooling, encryption, 24/7 support. Storage `$0.28`/provisioned GB/30-day month (≤ 1 TB); plans ~`$38`/mo (Basic, Shared-2x, 1 GB) → `$1,922`/mo (Performance-8x, 64 GB).
- **LiteFS** — a **FUSE filesystem that transparently replicates SQLite**: leases elect a **single primary** (time-based lease); writes forward to the primary, reads serve from local in-core replicas. Pairs with `fly-replay` for multi-region SQLite. **LiteFS Cloud** adds managed backups (~snapshot every 5 minutes). Stable but **pre-1.0**.
- **Tigris** — globally-distributed **S3-compatible** object storage (by Tigris Data), the **native object-storage provider** for Fly; provisioned via `fly storage`/extensions. Extends S3 with compare-and-set + metadata query.
- **Upstash** — **serverless Redis** (and **Upstash Vector**), integrated and provisioned via `fly extensions`; hosted on Fly.

### Compute extras — FKS & GPUs

- **Fly Kubernetes (FKS)** — a managed Kubernetes service built on **K3s + Virtual Kubelet**: `kubectl` requests translate into **Fly Machines** via the Machines API; volumes are Fly Volumes; networking is the internal WireGuard mesh; clusters live in a private VPN with per-pod Firecracker isolation. **`$75/month per cluster`** + compute/volume. **Closed beta — not recommended for critical production.**
- **Fly GPUs / "Fly.io for AI"** — A10 / L40S / A100 40G PCIe / A100 80G SXM, attached to a Machine via `gpu_kind`, on-demand per-GPU/hr (~`$0.75` A10, `$0.70` L40S, `$1.25` A100-40G, `$1.50` A100-80G). **Deprecated as of 2026-07-31** (["We Were Wrong About GPUs"](https://fly.io/blog/wrong-about-gpu/)): Fly concluded developers want LLM **APIs**, not rented GPUs, and is winding the offering down.

### Pricing

**Usage-based, per-second, no fixed plans, no free tier** (legacy orgs keep old allowances). Representative figures ([pricing](https://fly.io/docs/about/pricing/)):

- **Compute** — `shared-cpu-1x` 256 MB ≈ `$0.0028/hr` (~`$2.02/mo` if always-on); RAM ≈ `$5`/GB/30 days; `performance-1x` 2 GB ≈ `$32.19/mo`. **Regional multipliers**: NA/EU baseline, APAC ~1.25×, Africa/India ~3×. **Stopped** Machine rootfs `$0.15`/GB/30 days.
- **Volumes** `$0.15`/GB/mo; snapshots `$0.08`/GB/mo (10 GB free).
- **Bandwidth (egress)** `$0.02`/GB NA-EU · `$0.04`/GB APAC/Oceania/SA · `$0.12`/GB Africa/India; **inbound free**; private cross-region `$0.006`–`$0.05`/GB.
- **Networking** — dedicated IPv4 `$2/mo`; certs `$0.10/mo` (10 free/org); static egress IP `$0.005/hr`.
- **Reserved** — ~**40% off** with a machine reservation/commitment.
- **Support** — Standard `$29/mo` · Premium `$199/mo` · Enterprise from `$2,500/mo`.

Metered per-second billing **is the product** — the opposite of HoBo's deliberately **no-billing** stance ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Architecture

- **Control plane** — Fly's hosted service, with a machines API that is genuinely low-level: create,
  start, stop, destroy individual microVMs.
- **Data plane** — Firecracker microVMs on Fly's own hardware in many regions, joined by a private
  WireGuard-based network and fronted by Anycast.
- **Execution model** — build an image, place machines in chosen regions, route requests to the
  nearest healthy one; scale by adding machines rather than by an opaque autoscaler.
- **State authority** — Fly's platform state plus `fly.toml` in the repository.
- **Portability boundary** — the workload is an ordinary container image, which is genuinely
  portable; the *placement, networking and volume model* are Fly's. What does not move is the part
  that made it good.

## Where Fly.io is stronger

> Shipped, evidenced capability only.

### what Fly does genuinely well

- **Firecracker microVMs as the app runtime** — real per-app hardware isolation, sub-second boot, per-second billing, scale-to-zero + auto-start. A category above container-only PaaS on isolation, and **shipping in production** — something HoBo (wasm-default, design-phase) has **not** demonstrated.
- **A clean Machines REST API** — "VMs as an API" is a strong, composable primitive; FKS and many third-party products are built on it.
- **Real global-edge runtime** — Anycast + `fly-proxy` + WireGuard backhaul + `fly-replay` across regions on six continents, on **hardware Fly owns**. Deploy once, run near users, route writes to a primary. This is a **real, operating global network** — HoBo's Junction/edge story is design only.
- **LiteFS + `fly-replay`** — a distinctive, working **edge-SQLite** replication story with no real analog in the HoBo-adjacent field.
- **Low-ceremony DX** — one `fly.toml`, `fly launch`/`fly deploy`, Dockerfile-or-buildpacks, scale-to-zero out of the box.
- **A curated ecosystem** — Managed Postgres, Tigris (S3-compat object), Upstash (Redis/Vector), Sentry — provisioned with `fly extensions`.
- **It is a real cloud, not a reseller** — Fly operates physical hardware in many regions; the isolation and network are its own.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Fly's limits — HoBo's opening

- **Single-platform, not multi-cloud.** Fly *is* the cloud: your app runs on Fly's runtime, Fly's network, Fly's hardware. There is **no "same app on AWS/GCP/Azure/on-prem," no pluggable IaC, no provider-native escape hatch**. HoBo is **multi-cloud + IaC-agnostic** (Pulumi/Crossplane/TF/OpenTofu adapters, [Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) and can target **Fly itself** as one provider ([Fly provider proof HOBO-174](../design/proofs/hobo-174-provider-fly/index.md)).
- **Container/microVM-only; no polyglot component model.** You ship an OCI image; there is **no capability-secured wasm runtime, no WIT ports, no language-neutral contract**. HoBo's runtime is **wasm-default (wasmCloud)** with WIT ports + an OCI/container floor ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **No infrastructure-from-code.** `fly.toml` is hand-authored; Postgres/volumes/Tigris/Upstash are provisioned imperatively (CLI/extensions/API), **not declared-and-collected from app code**, and there is **no `.allow()` least-privilege model**. HoBo is **IfC-default** with `.allow()` → IAM + wasm link + token, one declaration, three effects ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **No event-sourced control plane / audit-replay; no policy/contracts planes; no Matching/Dispatcher.** Fly's control surface is imperative (`flyctl` + Machines API); **"same app, different infra per environment, auditably"** is not a concept. HoBo adds **Resource Definitions + Matching** (`match.Decided`, [Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)), a budget-aware **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)), an **event-sourced runtime** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)), and **contracts/`can-deploy` + policy** planes ([Plan 29](../design/contracts-policy-flags.md#plan-29)).
- **Thin managed-data breadth + HA caveats.** Postgres (MPG, new) + SQLite (LiteFS) + third-party Tigris/Upstash — but **no first-class vector/graph/document/search/OLAP as typed app resources**, and **no cross-cloud data migration/consistency**. Legacy Fly Postgres is self-run; Fly **Volumes are single-zone** (HA is your problem). HoBo formalizes a **paradigm taxonomy + opt-in packages** (`@hobo/sql`/`vector`/`graph`/`document`, [ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0081](../design/adr/03-data-plane.md#adr-0081)) + **app-data migration** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)).
- **Receding AI-infra; no AI-native platform.** Fly is **deprecating raw GPUs** (2026-07-31, "we were wrong about GPUs"); there is **no agents-as-principals model, no AI-generated providers, no trainable functions, no MCP control surface** for the platform itself. HoBo is **AI-native by design**: agents carry SVIDs ([Plan 6](../design/ai-native-agent-auth.md#plan-06)), the generation pipeline builds adapters ([Plan 23](../design/generated-stack.md#plan-23)), and `@hobo/mcp` is a control surface.
- **No multi-tenant-app primitives.** No app-tenant model / tenancy spectrum / per-tenant isolation/quota/residency — a SaaS builder rolls their own. HoBo ships this as a capability ([Plan 50](../design/security-networking.md#plan-50)/[ADR-0079](../design/adr/02-identity-security.md#adr-0079)/[ADR-0080](../design/adr/02-identity-security.md#adr-0080)).
- **No adopt-in-place onboarding.** Adoption means writing `fly.toml` + deploying to Fly; there is no "import my existing TF/Pulumi estate." HoBo's `hobo import` adopts existing estates in place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **Metered billing is the model — `✗`-by-design vs HoBo.** Fly monetizes per-second usage; HoBo has **no billing/monetization** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) and treats metering as **OSS FinOps showback** ([Plan 5](../design/reliability-observability-cost.md#plan-05)/[ADR-0039](../design/adr/02-identity-security.md#adr-0039)).
- **Some surfaces are early or receding** — FKS is **closed beta**; GPUs sunset **2026-07-31**; LiteFS is **pre-1.0**.

## Adversarial critique

- **Volumes are region-pinned and single-attached**, which is the sharp edge of the whole model: the
  compute is fluid and the state is not, so any stateful application inherits a placement problem
  the abstraction does not solve.
- **Operational history matters here.** Fly has publicly worked through significant reliability and
  capacity issues while scaling its own hardware; that transparency is creditable and the underlying
  fact — a smaller operator running its own metal globally — remains the risk a buyer is taking.
- **The abstraction leaks by design.** Machines, regions and volumes are exposed, so users make
  placement decisions with less information than the platform has and no scoring to help them.
- **Global by default is expensive by default.** Multi-region deployment multiplies cost, and the
  product's best feature is the one that does so.
- **Managed data is thinner than a hyperscaler's**, and colocating data with globally distributed
  compute is the hardest version of the problem.
- **No BYOC or self-host.** The network and placement model only exist inside Fly.

### Comparisons with adjacent tools

- **vs HoBo:** Fly is **a single, opinionated PaaS/cloud** — its own Firecracker runtime, its own Anycast network, its own hardware — ahead on **shipping global-edge runtime, microVM isolation, and physical footprint**. HoBo is **a meta-cloud control plane** that maps one app description onto **any** provider (Fly included) via **pluggable IaC + a wasm runtime**, then wraps it in **event-sourced governance, Matching/Dispatcher, broad data paradigms, AI-native depth, and multi-tenancy**. HoBo does not try to *be* Fly — it **consumes** Fly ([HOBO-174](../design/proofs/hobo-174-provider-fly/index.md), which by design excludes anycast/multi-region failover — exactly the parts Fly ships and HoBo doesn't).
- **vs Encore / Nitric:** Encore and Nitric are **infrastructure-from-code** (declare resources in app code → provision *your* cloud). Fly is **not IfC** — it is a runtime you deploy containers to, and it **owns the hardware** rather than provisioning into your account.
- **vs AWS / GCP / Azure (raw cloud):** Fly is a **developer-first cloud** — far simpler DX, global-by-default — but a **much narrower catalog** and **single-vendor**. HoBo targets the hyperscalers *and* Fly through one authoring model.
- **vs Cloudflare Workers:** both are edge, but Fly runs **full microVMs/containers** (any workload, any language) while Workers runs **V8 isolates/wasm** (constrained). HoBo targets **both** as providers ([`control-plane.md`](../design/control-plane.md#plan-04) lists Cloudflare and Fly side by side).
- **vs Render / Railway / Heroku:** Fly is **lower-level and more global** (Machines API, regions, Anycast); the others are higher-level git-push PaaS.

**Net:** Fly is a genuinely strong, **shipping** developer cloud — Firecracker microVMs, a clean Machines API, global Anycast + `fly-replay`, LiteFS — and on **real global-edge runtime, microVM isolation, and owned hardware it is ahead of HoBo**, which is still in design. But Fly is **single-platform by construction**: one runtime, one network, one hardware fleet, imperative config, metered billing, and a **receding** AI-infra story. HoBo's differentiation is orthogonal and does not require out-Fly-ing Fly: **multi-cloud portability + pluggable IaC (with Fly as one target), a wasm-default polyglot runtime, IfC authoring + Matching + the Dispatcher, event-sourced governance, a broad data-paradigm catalog, AI-native depth, multi-tenant-app primitives, and no-billing OSS** — mapping your app onto Fly *and everything else*.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Fly.io concept (✅ has · ➕ goes further · ◐ partial / design-phase · 🔜 planned, not shipped). Where Fly ships something HoBo has not proven, it is honestly ◐/🔜 — Fly is **ahead** on real global-edge runtime, microVM isolation, and hardware footprint.

| Fly.io concept | HoBo equivalent | Status |
|---|---|---|
| **Fly Machines** (Firecracker microVMs, per-app hardware isolation) | `component-host` runtime + `vm()`/`microVm()` IaaS adapters (Firecracker `BuildProvider`) ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ◐ HoBo's **default runtime is wasm**; `microVm` is a *designed* adapter — Fly's shipping per-app microVM isolation at scale is **unproven in HoBo** |
| **Machines REST API** (VMs-as-an-API) | control plane (Orchestrator + Executors) + host adapters ([Plan 4](../design/control-plane.md#plan-04)) | ◐ design-phase; Fly's API is shipping and battle-tested |
| **Apps v2** (Machines platform) | **Camps + Bindles** (deployed app unit) ([Plan 4](../design/control-plane.md#plan-04)) | ◐ |
| **`fly.toml`** (hand-authored config) | **IfC authoring + manifest IR** — resources declared in app code + `.allow()`, collected ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ declared-from-code, not hand-authored TOML; `.allow()` = IAM + wasm link + token |
| **`flyctl`** / `fly launch` / `fly deploy` | the **`hobo` CLI** (`hobo dev/up/plan/collect/build`) ([Plan 7](../design/developer-experience.md#plan-07)) | ✅ |
| **Anycast + `fly-proxy` + regions + `fly-replay`** | **Junction federation** ([ADR-0043](../design/adr/07-portability-extensibility.md#adr-0043)) + `domain`/DNS ingress ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)) + cross-Camp consistency ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) | 🔜 **DESIGN, not shipped**; overlay-mesh is an **open decision** ([ADR-P2](../design/adr/07-portability-extensibility.md)). **Fly is ahead** — real global-edge runtime |
| **Fly Volumes** (zone-local NVMe) | `volume()` IaaS resource + Fly volume via the provider adapter ([HOBO-174](../design/proofs/hobo-174-provider-fly/index.md)) | ◐ HoBo maps to **provider** volumes (incl. Fly's); no HoBo-native storage substrate |
| **Fly Postgres / Managed Postgres** | `hobo:sql` + `@hobo/sql` paradigm package + migrations ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0032](../design/adr/03-data-plane.md#adr-0032)) | ✅/➕ maps to cloud-native Postgres incl. Fly MPG; HoBo adds declarative migrations + more paradigms |
| **LiteFS** (edge SQLite replication) | *(none native)* — cross-Camp data consistency ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) | 🔜 **Fly ahead** — HoBo has **no shipping edge-SQLite** story |
| **Tigris** (S3-compatible object storage) | `wasi:blobstore` / `bucket` port; **Tigris as a provider seed** ([HOBO-174](../design/proofs/hobo-174-provider-fly/index.md)) | ✅ Tigris maps to the bucket port and is already a HoBo provider seed |
| **Upstash Redis / Vector** | `wasi:keyvalue` + the new **`cache` port** (ADR-0118, in progress) → Upstash mapping ([`control-plane.md`](../design/control-plane.md#plan-04)); vector via `@hobo/vector` ([ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ✅/◐ Upstash is a HoBo `cache`/KV seed |
| **Fly GPUs** (A10/L40S/A100 — *deprecating 2026*) | `hobo:job` (cpu/mem/gpu) + `vm`/`microVm` ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ◐ HoBo maps GPU jobs to **provider** GPUs; Fly is **exiting** raw-GPU hosting |
| **Fly Kubernetes (FKS)** | `@hobo/provider-kubernetes` adapter ([HOBO-182](../design/proofs/hobo-182-provider-kubernetes/index.md)) + component-host cert ([ADR-0102](../design/adr/01-architecture-core.md#adr-0102)) | ◐ HoBo targets k8s as a **substrate**, not a managed-k8s product |
| **Fly extensions** (Tigris/Upstash/Sentry/MPG) | provider adapters + **Resource Definitions + Matching** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) + Dispatcher ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ same "provision a backing service" idea, but Matching **selects + cost-routes** |
| **`fly-proxy` TLS / `fly certs`** | `domain` + ACME cert issuance ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)) | ◐ designed; Fly ships it |
| **Usage/consumption billing** (per-second) | *(none — by design)* **FinOps showback, no billing** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)/[ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗-by-design — HoBo does **not** monetize; metering is OSS showback |
| **Single-platform** (Fly's runtime/network/hardware) | **multi-cloud + pluggable IaC** — one app onto any provider, Fly included ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006); [HOBO-174](../design/proofs/hobo-174-provider-fly/index.md)) | ➕ the **core contrast** |
| *(none — container-only)* | **wasm-default polyglot runtime + WIT ports** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ |
| *(none)* | **event-sourced control plane + audit/replay** ([Plan 11](../design/data-plane.md#plan-11)) | ➕ |
| *(none)* | **contracts/`can-deploy` + policy planes** ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ➕ |
| *(none)* | **agents-as-principals + MCP + brokered tokens** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ |
| *(none)* | **generation pipeline** — AI-generated providers/impls ([Plan 23](../design/generated-stack.md#plan-23)) | ➕ |
| *(none)* | **multi-tenant-app primitives** ([Plan 50](../design/security-networking.md#plan-50)/[ADR-0079](../design/adr/02-identity-security.md#adr-0079)) | ➕ |
| *(none — greenfield-leaning)* | **`hobo import`** adopt-in-place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ |

### The one-line takeaway

**Fly is a shipping developer cloud that is genuinely ahead of HoBo on the things HoBo hasn't built — real Firecracker microVM isolation, a global Anycast edge runtime with `fly-replay`, LiteFS, and owned hardware in many regions — but it is single-platform by construction (its own runtime, network, hardware, imperative config, metered billing, receding AI-infra).** HoBo doesn't compete to *be* Fly; it **maps one app description onto Fly and every other provider** via pluggable IaC + a wasm runtime, then adds IfC authoring + Matching/Dispatcher, event-sourced governance, broad data paradigms, AI-native depth, multi-tenancy, and no-billing OSS — which is why Fly appears in HoBo's design **both** as a competitor **and** as a `CloudProvider` seed ([HOBO-174](../design/proofs/hobo-174-provider-fly/index.md)).

## Better-together / integration posture

- **Borrow** — **explicit placement as a user-visible concept**. Fly proves that developers will
  engage with placement when it is legible; HoBo's scored matching should *show* its reasoning rather
  than hide it, which is the same lesson from the other direction.
- **Provider-target** — a strong one: Fly machines are a natural realization for latency-sensitive
  Bindle workloads.
- **Benchmark** — microVM start times and the Anycast routing story.
- Not an adopt or displace target.

## Threats and lessons

1. **Placement is a feature users want to see**, not one they want hidden. HoBo's advantage over Fly
   is that the decision can be *scored and explained*; that only lands if it is surfaced.
2. **State placement is the unsolved problem across this entire corpus.** Region-pinned volumes here,
   no data cloning elsewhere. Any HoBo claim about moving workloads must confront where the data is.
3. **Running your own global hardware is a hard business.** It buys latency and control and makes
   reliability the operator's own problem — relevant when evaluating Railway Metal's similar bet.

## Sources

- [fly.io/docs](https://fly.io/docs/) — apps, `fly.toml`, regions, Anycast, volumes
- [Machines](https://fly.io/docs/machines/) — the microVM primitive and its API
- [fly.io](https://fly.io/) — positioning (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current region list, pricing and managed-data offerings were not
re-verified in this pass and are not asserted.
