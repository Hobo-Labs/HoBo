---
type: Competitive Reference
title: "Render — competitor reference"
description: "Render is a **single-vendor managed cloud platform** (the Heroku-successor push-to-deploy PaaS): connect a Git repo and Render builds, deploys, autoscales, and operates web services, static sites, workers, cron jobs, and private services plus managed Postgres and Key Value — all on Render's own infrastructure, optionally declared via `render.yaml` Blueprints."
tags: [hobo, competitors]
competitor:
  slug: render
  name: "Render"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms]
  directness: overlapping
  role: "unified managed cloud with render.yaml Blueprints — Heroku-successor PaaS benchmark"
  posture: [benchmark]
  hobo_surface: [authoring, environments, delivery]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://render.com/docs
    - https://render.com/
---

# Render — competitor reference

> A faithful, detailed capture of **Render** for HoBo competitive analysis. Render is a **single-vendor managed cloud platform** — the Heroku-successor "push-to-deploy" PaaS: connect a Git repo and Render **builds, deploys, autoscales, and operates** web services / static sites / background workers / cron jobs / private services, plus managed **Postgres** and **Key Value (Redis®-compatible)**, optionally declared as code via **`render.yaml` Blueprints** — all on **Render's own infrastructure** (AWS regions under the hood, not exposed), with **no bring-your-own-cloud and no self-host**. Render is a **shipping, commercial GA product** with real operational maturity; HoBo is design-phase. Sources: [render.com](https://render.com/) · [render.com/docs](https://render.com/docs) · [Blueprint spec](https://render.com/docs/blueprint-spec) · [pricing](https://render.com/pricing) · [MCP server](https://render.com/docs/mcp-server) · [Terraform provider](https://render.com/docs/terraform-provider) · [CLI](https://render.com/docs/cli). Proprietary/commercial. Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Render is a **managed cloud platform (PaaS)** positioned as the modern Heroku successor: *"Connect your repo and ship with every push."* You point Render at a Git repository; it **builds, deploys, load-balances, terminates TLS, autoscales, and operates** your services and datastores for you. The surface is five service types — **Web services · Static sites · Private services · Background workers · Cron jobs** (plus **Workflows**, a beta durable-task engine) — over managed **Postgres**, managed **Key Value**, and **persistent disks**. The defining property versus HoBo/Encore/Nitric: **Render owns and runs the infrastructure.** There is no cloud account of yours, no IAM to write, no Terraform required — you get a **single dashboard and a single bill**, and Render's operations team keeps it up.

Authoring is **dashboard-first**, but Render also ships a declarative **`render.yaml` Blueprint** (Infrastructure as Code) for repeatable multi-service environments, an **official Terraform provider** (`render-oss/render`), and a **public REST API**. Crucially, a Blueprint declares **Render's own products and plans** — it is *IaC over Render's fixed managed catalog*, not *infrastructure-from-your-code*, and the resource→backend mapping is fixed to Render's fleet (no equivalence classes, no per-environment realization, no provider choice).

Render runs entirely on **its own infrastructure** across five regions — **Oregon, Ohio, Virginia, Frankfurt, Singapore** (AWS underneath, but abstracted away and not selectable). There is **no bring-your-own-cloud (BYOC), no multi-cloud, and no self-hostable control plane**: you cannot deploy into your own AWS/GCP/Azure account or run Render on-prem. Billing is **metered managed hosting** — per-instance compute prorated to the second, per-user workspace fees, and usage-based data/bandwidth. This single-vendor, managed-hosting posture is the categorical contrast with HoBo (a cloud-agnostic control plane where **self-host = hosted**).

| Dimension | Render |
|---|---|
| Category | Single-vendor **managed cloud platform / PaaS** (Heroku successor) — **Render operates the infra** |
| Authoring | **Dashboard-first** + declarative **`render.yaml` Blueprints** (IaC) + official **Terraform provider** (`render-oss/render`) + **REST API** |
| Service types | **Web services · Static sites · Private services (`pserv`) · Background workers · Cron jobs**; **Workflows** (beta durable tasks) |
| Runtimes | **Native** (Node · Python · Ruby · Go · Rust · Elixir) **+ Docker** (Dockerfile build or prebuilt `image`); monorepo support |
| Managed data | **Postgres** (HA failover · read replicas · PITR · pgbouncer · pgvector/PostGIS) · **Key Value** (Valkey 8 / Redis 6) · **persistent disks**; **no first-party object storage** (alpha; MinIO template / BYO S3) |
| Deploy model | **Git-push auto-deploy** — build + zero-downtime deploy on every push; managed TLS + custom domains; health checks |
| Scaling | **Autoscaling** (target CPU/mem %, min/max, Pro+) + manual (up to 100 instances); load-balanced; billed per-second |
| Clouds | **Render's own infrastructure only** — 5 regions (Oregon/Ohio/Virginia/Frankfurt/Singapore, AWS underneath); **no BYOC · no multi-cloud · no self-host** |
| AI | Official **MCP server** (hosted `mcp.render.com/mcp`) + installable **agent skills** (`render-deploy/debug/monitor`) + `llms.txt`/`llms-full.txt` |
| License / price | **Proprietary, commercial**; workspace tiers (Hobby free / Professional ≈$19/user/mo / Organization ≈$29/user/mo) **+ metered compute** (Starter $7 · Standard $25 · Pro $85 · Pro Plus $175 /mo) **+ managed data** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Service** | The unit of deployment, typed by shape: web service, static site, background worker, cron job, private service |
| **Blueprint (`render.yaml`)** | Declarative infrastructure-as-code for the whole project, committed to the repository |
| **Managed Postgres / Key Value** | First-party managed data services |
| **Environment group** | Shared configuration and secrets across services |
| **Preview environment** | Per-pull-request instances defined by the Blueprint |

The mental model is **typed services declared in the repository**. Render's distinguishing choice is
that service *type* is explicit — a web service, a worker and a cron job are different things with
different lifecycles — rather than everything being a container with different flags.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | `render.yaml` is a compact, complete, repository-resident topology description |
| `environments` | Blueprint-defined preview environments per pull request |
| `delivery` | Push to deploy with zero-downtime rollouts |
| `app-graph` | Services plus environment groups form a small application graph |

Render contests the same "declare it in the repo" ground HoBo occupies, at a much lower ceiling and
with no provider choice.

## Feature surface

### Service types — the five (+ Workflows)

- **Web services** — public HTTP apps; auto-assigned `onrender.com` subdomain, managed TLS, custom domains; git-push auto-deploy, `healthCheckPath`, **zero-downtime deploys**, load-balanced across instances.
- **Static sites** — built from a repo and served on a **global CDN** with custom `headers`, `routes` (redirect/rewrite), and a `staticPublishPath`; free.
- **Private services (`pserv`)** — *"private services aren't reachable via the public internet"*; they get no `onrender.com` subdomain and are *"reachable by your other Render services on the same private network"* (per workspace + region). Bind ≥1 port, any protocol — for internal backends/caches.
- **Background workers** — long-running async processors; *"background workers aren't even reachable via their private network"* — outbound-only, for queues/jobs.
- **Cron jobs** — scheduled commands on a cron expression.
- **Workflows (beta)** — *"an end-to-end orchestration and execution engine for long-running, distributed tasks."* Define tasks as *"standard TypeScript or Python functions"*, register them with Render; tasks can **chain other tasks** (each run *"in its own instance"*), with **automatic retries**, **up to 24h** per run, per-task compute specs, and a fully managed queue. Render's answer to durable execution / job-queue infra.

### `render.yaml` Blueprints (Infrastructure as Code)

Top-level keys: **`services`** (web/static/worker/cron/keyvalue), **`databases`** (Postgres), **`envVarGroups`**, **`previews`**, and **`projects`** (environments grouping services + databases). Service `type` ∈ `web` (web service *or* static site) · `pserv` · `worker` · `cron` · `keyvalue`. `runtime` ∈ `node`/`python`/`ruby`/`go`/`rust`/`elixir` (native) · `docker` (build from Dockerfile) · `image` (prebuilt) · `static`.

```yaml
# render.yaml — a Blueprint declares Render's own products + plans (IaC over a fixed catalog)
previews:
  generation: automatic            # auto-create a preview environment per PR (Pro+)
  expireAfterDays: 5

services:
  - type: web
    name: api
    runtime: node                  # or docker | python | go | ruby | rust | elixir
    plan: standard                 # free | starter | standard | pro | pro plus | pro max | ...
    region: oregon                 # oregon | ohio | virginia | frankfurt | singapore
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /healthz
    scaling:                       # autoscaling
      minInstances: 1
      maxInstances: 10
      targetCPUPercent: 60
      targetMemoryPercent: 60
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: app-db, property: connectionString }
      - key: CACHE_URL
        fromService: { name: cache, type: keyvalue, property: connectionString }
      - key: SECRET_KEY
        generateValue: true        # Render generates + stores a value
      - key: PROMPT_ME
        sync: false                # value entered in dashboard, not committed

databases:
  - name: app-db
    plan: basic-1gb
    postgresMajorVersion: "16"
    diskSizeGB: 10
    readReplicas:
      - name: app-db-replica       # + highAvailability (standby) for automatic failover
```

Note the env-var affordances Render exposes declaratively: **`fromDatabase`**/**`fromService`** wiring, **`generateValue`** for secrets, **`sync: false`** for dashboard-entered values, and shared **`envVarGroups`**. `ipAllowList` (required for Key Value), `disk` (`mountPath`/`sizeGB`), and `preDeployCommand`/`initialDeployHook` round out the schema.

### Runtimes: native + Docker

- **Native language runtimes** — *"native language runtimes that don't require Docker"* for **Node, Python, Ruby, Go, Rust, Elixir**, with auto-detected `buildCommand`/`startCommand`.
- **Docker** — either *"build their own image at deploy time based on the Dockerfile in your project repo"* or *"pull and run a prebuilt image from a registry"* (`runtime: image`). Render recommends Docker for unsupported languages (PHP/JVM), OS-level packages, or reproducible builds. Advanced **Docker Command** override; **monorepo support** for multi-service repos.

### Managed data: Postgres, Key Value — and the object-storage gap

- **Postgres** — *"fully managed, enterprise-grade databases that scale to any workload."* Ships **High Availability** (automatic failover to a standby), **read replicas**, **connection pooling** (pgbouncer), **point-in-time recovery** + backups, and extensions **pgvector** (embeddings) + **PostGIS**. **Flexible plans** (independently sized storage/compute) or legacy instance types (Starter/Standard/Pro/Pro Plus). Free tier: 1 GB, **expires 30 days** after creation.
- **Key Value** — *"low-latency in-memory storage that's ideal for shared caches and job queues."* Runs **Valkey 8** (new instances) / **Redis 6** (legacy), *"compatible with virtually all clients that interact with Redis®"* (*"Redis is a registered trademark of Redis Ltd."*). Persistence modes **Journal + Snapshot / Snapshot only / Off**; maxmemory eviction policies (`allkeys-lru` recommended for caching, `noeviction` for job queues). Free instances are **in-memory only** (ephemeral — data lost on restart).
- **Object storage — absent as a first-party product.** Render offers **no managed S3-compatible bucket service** (cloud object storage is an open feature request / alpha). The documented paths are **self-deploying MinIO** (S3-compatible, on a 10 GB Render disk with daily snapshots) via template, or **bringing your own** S3 / Cloudflare R2. This is a genuine missing primitive versus S3-native platforms — and versus HoBo's `bucket` port.
- **Persistent disks** — block storage attached to a service (`mountPath`, `sizeGB`), daily snapshots; but *"services with persistent disks cannot scale to multiple instances."*

### Preview environments

Enabled in `render.yaml` (Pro plan+): `previews.generation: automatic | manual | off` (deprecated `previewsEnabled: true` ≡ automatic). **Automatic** creates a preview per PR (skip with `[skip preview]` in the title); **manual** requires `[render preview]` in the title. *"A preview environment creates new instances of the services and datastores defined in your Blueprint … These instances do not copy any data."* Render *"automatically destroys them when the original pull request is merged or closed"*; `previews.expireAfterDays` auto-reaps idle previews; `previews.plan`/`previewPlan` pick cheaper instances; `initialDeployHook` seeds data after first deploy.

### Scaling & availability

Manual scaling to a fixed **1–100** instances. **Autoscaling** (Pro workspaces+) *"automatically scales your number of instances between a specified minimum and maximum, based on target CPU and/or memory utilization"* — scale up immediately on threshold breach, wait several minutes before scaling down. Applies to **web / private / worker** services; traffic is *"load balanced evenly across all running instances"*; billing is **prorated by the second**. Disk-attached services cannot run multiple instances.

### CLI + REST API + Terraform

```bash
render login                       # browser-authorize the CLI
render workspace set               # switch active workspace
render services [create]           # list (interactive) / create (non-interactive)
render deploys list  [SERVICE_ID]  # deploy history
render deploys create [SERVICE_ID] --wait --commit <sha>
render psql [DATABASE_ID] -c "select 1" -o json    # psql session / one-shot query
render ssh  [SERVICE_ID] --ephemeral               # shell into an instance
render blueprints validate render.yaml
render skills [install | update | remove | list]   # install Render's agent skills
```

Interactive by default; **non-interactive/scriptable** with `-o json|yaml|text` + `--confirm` and `RENDER_API_KEY` for automation. Beyond the CLI, Render exposes a **public REST API** (`api-docs.render.com`) and an **official Terraform provider** (`render-oss/render`, in the Terraform Registry) to manage Render resources from existing Terraform — i.e. IaC *targeting Render's managed catalog* (the opposite direction from HoBo consuming IaC tools underneath).

### AI / agent surface

- **MCP server** — official, hosted at `https://mcp.render.com/mcp` (also local via Docker/binary), API-key authed. Tools by resource: **Services** (create web services / static sites / cron jobs / databases; list/get; update env vars), **Postgres** (read-only SQL; create/manage), **Key Value** (create/manage), **Logs** (filter/retrieve), **Metrics** (CPU/mem/instances/response times/bandwidth), **Deploys** (history). Deliberately limited: *cannot delete* resources (except env vars), no image-backed services / IP allowlists, cannot trigger deploys or change scaling.
- **Agent skills** — installable via `render skills install` (CLI 2.10+) into `~/.claude/skills/…`, Cursor, Codex: **`render-deploy`** (*"Deploy applications using IaC with Render Blueprints or directly via MCP"*), **`render-debug`**, **`render-monitor`**.
- **LLM docs** — `llms.txt` / `llms-full.txt` and `.md`-suffixed doc URLs for machine-readable grounding.

### Pricing shapes

- **Workspace tiers** (on top of compute): **Hobby** (free) · **Professional** ≈$19/user/mo · **Organization** ≈$29/user/mo · Enterprise (custom).
- **Compute**, prorated to the second: **Free** (web services *"spin down"* after **15 min** idle, ~1 min cold start, **750** free instance-hours/mo/workspace) · **Starter** $7/mo (512 MB / 0.5 vCPU) · **Standard** $25/mo (2 GB / 1 vCPU) · **Pro** $85/mo (4 GB / 2 vCPU) · **Pro Plus** $175/mo (8 GB / 4 vCPU) · larger Pro Max/Ultra.
- **Postgres**: Free (1 GB, 30-day expiry) → flexible/instance plans; storage ≈$0.30/GB/mo beyond included.
- **Key Value**: Free (ephemeral) → Starter ≈$10/mo (25 MB) up to 10 GB+.
- **Static sites** free; **outbound bandwidth** + **build-pipeline minutes** metered per workspace.

## Architecture

- **Control plane** — Render's hosted service.
- **Data plane** — Render's own infrastructure; services run as managed containers with typed
  lifecycles.
- **Execution model** — build from the repository, deploy per service type, apply Blueprint changes
  as a plan across the project.
- **State authority** — the `render.yaml` in the customer's repository for declared topology, plus
  Render's own state for everything provisioned. Genuine config-as-code within the platform's scope.
- **Portability boundary** — none. The Blueprint schema is Render's, and the services it declares are
  Render service types.

## Where Render is stronger

> Shipped, evidenced capability only.

### what Render does well

- **Managed simplicity + operational maturity, shipping today.** Render *operates* the whole stack — build, deploy, TLS, DNS, load-balancing, HA Postgres with failover + PITR + read replicas, autoscaling — as a **battle-tested GA product**. Connect a repo, push, and it runs. This is the bar for "it just works, in production, right now" — and HoBo is design-phase, so Render is genuinely ahead here.
- **Single-pane DX.** One dashboard and one bill for compute, data, cron, workers, previews, logs, and metrics. No cloud accounts, no IAM authoring, no Terraform required to get started.
- **Git-push-to-deploy** with **zero-downtime deploys**, **per-PR preview environments** (services *and* datastores), and health checks — the Heroku experience, modernized.
- **Managed Postgres is genuinely strong** — HA failover, read replicas, PITR, pgbouncer, pgvector/PostGIS — zero-ops, which most IfC/BYOC tools push back onto you.
- **Real IaC path** — declarative Blueprints + Projects/environments + an **official Terraform provider** + REST API, so environments are repeatable, not click-only.
- **Concrete, shipping AI-agent surface** — official hosted **MCP server** + installable **agent skills** + `llms.txt`. Render ships agent DX ergonomics *today*.
- **Predictable, transparent pricing**, prorated to the second, with a usable free tier.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Render's limits — HoBo's opening

- **Single-vendor managed hosting — no multi-cloud, no BYOC, no self-host.** Everything runs on **Render's own infrastructure** (5 regions, AWS underneath but abstracted away). You **cannot** deploy into your own AWS/GCP/Azure account, cannot run Render on-prem, cannot pin a resource to a chosen provider, and there is **no self-hostable control plane**. This is the categorical contrast: HoBo is a **cloud-agnostic control plane** that maps one app onto **any mix of real providers** with **pluggable IaC** (Pulumi/Crossplane/TF/OpenTofu) and **self-host = hosted** (Yard-is-a-Bindle) — [Plan 4](../design/control-plane.md#plan-04) / [ADR-0006](../design/adr/01-architecture-core.md#adr-0006).
- **No first-party object storage.** A core primitive (buckets/blob) is **absent** — the documented path is self-hosting MinIO on a disk or BYO S3/R2. HoBo ships a **`bucket` port** (`wasi:blobstore` + blob-events) in its catalog ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **`render.yaml` is IaC over a fixed managed catalog, not infrastructure-from-code.** Blueprints declare **Render's own products + plans**, not resources inferred from your app, and the mapping is **fixed to Render's fleet** — no equivalence classes, no per-environment realization, no provider choice. HoBo collects resources from the app (IfC) and **Resource Definitions + Matching** realize the *same app* to *different infra per environment*, auditably (`match.Decided`) ([Plan 25](../design/platform-engineering.md#plan-25) / [ADR-0033](../design/adr/01-architecture-core.md#adr-0033)), with the cost-aware **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No language-neutral runtime / capability model.** Native runtimes + Docker containers only; no wasm/WASI component model, no capability-based linking, no polyglot-via-components. HoBo's runtime contract is **WIT/wasm** ([Plan 20](../design/wasm-runtime-wit.md#plan-20) / [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **No event-sourced control plane / durable audit-replay.** Render Workflows (beta) is a managed task engine with retries, but there's no event-sourced platform substrate, no replay/audit of control-plane decisions, no actors/choreography-sagas as a first-class model. HoBo's runtime is **event-sourced**: actors + workflows + sagas + replay/audit ([Plan 11](../design/data-plane.md#plan-11) / [ADR-0003](../design/adr/01-architecture-core.md#adr-0003) / [ADR-0004](../design/adr/01-architecture-core.md#adr-0004) / [ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No governance / policy / contracts planes over the platform.** No `can-deploy` contracts, policy engine, or progressive-delivery/experiment plane (Render has previews + rollbacks, not OpenFeature/OpenDelivery/OpenExperiment). HoBo adds **contracts/policy/flags** ([Plan 29](../design/contracts-policy-flags.md#plan-29)) + the **Harness** ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)) + governance planes ([ADR-0015](../design/adr/02-identity-security.md#adr-0015)).
- **No `.allow()` one-decl-three-effects / IfC-derived least-privilege.** Render has env vars, IP allow lists, and workspace RBAC, but not capability grants derived from declared use. HoBo's `.allow()` → **IAM + wasm capability link + agent token scope** (one declaration, three effects) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **Agents are tooling, not principals.** The MCP server + skills let an agent *drive* Render, but an agent is not a first-class identity with brokered, scoped, audited tokens. HoBo makes **agents principals** with SVIDs + brokered tokens + MCP control surface ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **No AI-generation pipeline** — no AI-generated providers/implementations, no conformance-gated adapter synthesis, no trainable semantic functions. HoBo has the **generation pipeline** ([Plan 23](../design/generated-stack.md#plan-23) / [ADR-0010](../design/adr/03-data-plane.md#adr-0010)) + `"use training"`.
- **No brownfield adopt-in-place.** No "import my existing infra"; adoption means moving onto Render's fleet, and leaving means a rewrite off the platform (single-vendor lock-in). HoBo's **`hobo import`** adopts TF/Pulumi/FaaS estates in place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **Single-tenant-app oriented.** No multi-tenant-app primitives (per-tenant isolation/routing/quota/residency/lifecycle). HoBo ships this as a capability ([Plan 50](../design/security-networking.md#plan-50)).

**Not a gap (by design):** Render's **metered, managed-hosting billing** — per-instance compute, per-user workspace fees, usage-based data/bandwidth — is its *business model*, not a feature HoBo is missing. HoBo deliberately excludes **billing/monetization/paid-marketplace** from design scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) and does **cost showback via OSS FinOps** ([Plan 5](../design/reliability-observability-cost.md#plan-05) / [ADR-0039](../design/adr/02-identity-security.md#adr-0039)), not a bill. Different product category, not a deficiency.

## Adversarial critique

- **Typed services are an expressive ceiling.** Five service shapes cover common web applications and
  exclude actors, durable workflows, GPU work and anything event-driven beyond a worker loop.
- **The Blueprint is Render's schema.** It is genuinely config-as-code and genuinely non-portable;
  the file describes Render services, not an application.
- **Single vendor, single region per service.** No BYOC, no self-host, no multi-region topology.
- **Managed data is first-party only.** Postgres and Key Value are what is offered; there is no path
  to a hyperscaler's managed service under the same abstraction.
- **Preview environments cost real money** and, as everywhere in this cohort, do not solve the data
  problem — a preview with an empty database tests less than it appears to.
- **The Heroku-successor position is a following position.** The product is defined by improving a
  known experience rather than by a distinct architectural claim, which is commercially sound and
  strategically fragile if the category shifts.

### Comparisons with adjacent tools

- **vs HoBo:** Render is **single-vendor managed hosting with excellent DX**; HoBo is a **cloud-agnostic control plane** that maps one app onto any mix of real clouds (or self-host), event-sourced + AI-native + governed. Render is the benchmark for **managed simplicity + operational maturity today**; HoBo's bet is **portability + control-plane depth + no lock-in** — but HoBo is unshipped, so Render decisively wins "runs in production now."
- **vs Heroku:** Render *is* the de-facto Heroku successor — same push-to-deploy ergonomics, modern managed data, better pricing, more service types.
- **vs Vercel / Netlify:** those are frontend/edge-first; Render is backend/full-stack-first (long-running services, workers, cron, private services, HA Postgres).
- **vs Fly.io / Railway:** peer managed-PaaS competitors; Render skews toward **managed-data depth + enterprise features** (HA Postgres, autoscaling, previews). All are single-vendor.
- **vs Encore / Nitric:** Encore and Nitric are **infrastructure-from-code that deploys into *your own* cloud**; Render is **managed hosting on *Render's* cloud** — the opposite side of the BYOC line. Render's Blueprint is IaC over Render's catalog, not IfC over your code, and not multi-cloud.
- **vs AWS/GCP/Azure directly:** Render **abstracts the hyperscaler away** for simplicity (you never see the account); HoBo instead **orchestrates** the hyperscalers (you keep them; HoBo maps onto them and can self-host).

**Net:** Render is the **managed-simplicity + operational-maturity benchmark** — a shipping, single-pane PaaS that HoBo cannot match on "runs in production today." But Render is **single-vendor managed hosting on its own infra**, with a **fixed managed-service catalog**, **no object storage**, **no multi-cloud/BYOC/self-host**, **no language-neutral runtime**, and **no event-sourced/governed/AI-native control plane**. HoBo's whole thesis is the inverse — **cloud-agnostic + pluggable-IaC + self-host = hosted**, a **wasm/WIT runtime**, **Resource Definitions/Matching + the Dispatcher**, **event-sourced governance**, and **agents-as-principals** — trading Render's turnkey managed hosting for portability, control, and no lock-in.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Render concept. **✅** designed at parity (real HoBo anchor) · **➕** HoBo goes further · **◐** partial/thin in HoBo's design · **🔜** planned/in-progress · **✗ by design** deliberately out of scope. HoBo is **design-phase/unshipped** — ✅ denotes a *designed* anchor, **not a shipping feature**; Render's *managed operations* (running the fleet, HA data, autoscaler, single-pane ops) are genuinely ahead of anything HoBo has shipped.

| Render concept | HoBo equivalent | Status | Notes |
|---|---|---|---|
| **Web service** (managed HTTP app) | `service`/`api` port (`hobo:http`, route security [ADR-0114](../design/adr/02-identity-security.md#adr-0114)) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ | authoring port designed; **Render ships the managed runtime/TLS/LB/build** — HoBo unshipped |
| **Static site** | `web` resource (static/SSR + CDN) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); UI gen ([ADR-0056](../design/adr/03-data-plane.md#adr-0056)) | ✅ | port designed |
| **Private service (`pserv`) + private network** | internal services + networking / multi-tenant primitives ([Plan 50](../design/security-networking.md#plan-50)) | ◐ | networking designed; managed private-network *operations* thin/unshipped |
| **Background worker** | actors / durable workflows / `hobo:job` ([Plan 11](../design/data-plane.md#plan-11)) | ➕ | HoBo adds durable **event-sourced** execution (replay/audit) |
| **Cron job** | `hobo:schedule` (control-plane cron) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | port designed |
| **Workflows (beta)** — durable task orchestration | event-sourced runtime: actors + workflows + **sagas + replay** ([Plan 11](../design/data-plane.md#plan-11), [ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ | deeper model (replayable/audited); **Render ships a managed engine now** |
| **`render.yaml` Blueprint** (IaC over fixed catalog) | IfC authoring → **manifest IR + Resource Definitions/Matching** ([Plan 21](../design/authoring-resources-wiring.md#plan-21), [Plan 25](../design/platform-engineering.md#plan-25)) | ➕ | HoBo infers from code + realizes **per-env**, not a fixed managed catalog |
| **Terraform provider + REST API** | **pluggable IaC adapters** (Pulumi/Crossplane/TF/OpenTofu) ([Plan 4](../design/control-plane.md#plan-04), [ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) + `hobo import` ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ | opposite direction — HoBo *consumes* IaC underneath + adopts estates in place |
| **Native + Docker runtimes** | **wasm/WIT-default** runtime + OCI container floor ([Plan 20](../design/wasm-runtime-wit.md#plan-20), [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ | polyglot-via-components + capability security |
| **Managed Postgres** (HA · read replicas · PITR · pgbouncer) | `hobo:sql` + `@hobo/sql` + auto-diff migrations ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) → **provider natives** | ◐ | port designed + maps to a provider's managed DB; **HoBo does not operate a managed Postgres fleet** — HA/PITR delegated to the chosen provider |
| **pgvector / PostGIS** | first-class `vector`+`search` port ([ADR-0034](../design/adr/03-data-plane.md#adr-0034)) + `@hobo/vector`/`@hobo/graph` ([ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ➕ | paradigm ports, not a Postgres extension |
| **Key Value** (Valkey/Redis) | `hobo:kv` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) + app-facing `cache` port (TTL/eviction, ADR-0118 *in progress*) | ✅ / 🔜 | `kv` designed; dedicated `cache` port still in progress |
| **Object storage** (absent — MinIO/BYO S3) | **`bucket` port** (`wasi:blobstore` + blob-events) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ | HoBo designs a first-class bucket port **Render lacks** |
| **Persistent disks** | provider block-storage / volume mapping ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ | disk/volume semantics thin; delegated to provider |
| **Preview environments** (per-PR) | ephemeral/preview **Camps** + the **Harness** (OpenDelivery/OpenExperiment) ([Plan 25](../design/platform-engineering.md#plan-25), [ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ➕ | previews + progressive delivery; **Render ships previews today** |
| **Autoscaling** (target CPU/mem, min/max) | reliability/HA plane + Matching-realized scaling ([Plan 5](../design/reliability-observability-cost.md#plan-05)) | ◐ | scaling *intent* via Matching/provider natives; **no shipped autoscaler** |
| **Git-push managed build + zero-downtime deploy** | `hobo up`/`dev` + contracts `can-deploy` ([Plan 7](../design/developer-experience.md#plan-07), [Plan 29](../design/contracts-policy-flags.md#plan-29)) | ◐ | deploy CLI + gates designed; **managed git build pipeline is Render's operational maturity** |
| **Single-pane managed dashboard** (logs/metrics/deploys) | dashboard + observability (OTel) + ops/status pages ([Plan 7](../design/developer-experience.md#plan-07), [Plan 5](../design/reliability-observability-cost.md#plan-05), [Plan 49](../design/developer-experience.md#plan-49)) | ◐ | designed, unshipped; **Render's dashboard is mature today** |
| **Workspaces + team roles (RBAC)** | org/workspace + RBAC/SSO/SCIM ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | ✅ | designed |
| **IP allow lists / env vars / secrets** | `secret` port ([ADR-0113](../design/adr/02-identity-security.md#adr-0113)) + route security ([ADR-0114](../design/adr/02-identity-security.md#adr-0114)) + `.allow()` least-priv ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ | one decl → IAM + wasm link + token scope |
| **MCP server** (drive Render) | `@hobo/mcp` + **agents as principals** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ | agents are first-class identities with brokered, audited tokens |
| **Agent skills + `llms.txt`** | AI-native surface ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) + generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)) | ◐ | HoBo's agent-principal + generation model goes further architecturally, but **Render ships concrete skills/llms.txt today** |
| **Single-vendor infra** (no BYOC/self-host) | multi-cloud adapters + **self-host = hosted** (Yard-is-a-Bindle) ([Plan 4](../design/control-plane.md#plan-04), [ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ | the categorical contrast |
| **Metered managed-hosting billing** | **out of scope** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); cost **showback** only ([Plan 5](../design/reliability-observability-cost.md#plan-05), [ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗ by design | not a gap — HoBo has no billing/monetization |

### The one-line takeaway

**Render is the managed-simplicity + operational-maturity benchmark — a shipping, single-pane PaaS that HoBo (design-phase) cannot yet match on "runs in production today."** But Render is **single-vendor managed hosting on its own infra**, with a **fixed managed catalog (no object storage), no multi-cloud/BYOC/self-host, no language-neutral runtime, and no event-sourced/governed/AI-native control plane** — precisely the axes HoBo is designed around: **cloud-agnostic + pluggable-IaC + self-host = hosted**, a **wasm/WIT runtime**, **Resource Definitions/Matching + the Dispatcher**, **event-sourced governance**, and **agents-as-principals**.

## Better-together / integration posture

- **Benchmark** — `render.yaml` is the ceremony budget for declarative topology: if HoBo's manifest
  is meaningfully heavier for a simple web application, that is a defect.
- **Borrow** — **explicit service types**. Making "this is a cron job, not a web service" part of the
  declaration rather than a flag is good design and maps naturally onto Bindle kinds.
- **Provider-target** — plausible for web-shaped Bindles.
- Not an adopt or displace target.

## Threats and lessons

1. **Declarative-in-the-repo is the expected default now**, not a differentiator. HoBo gets no credit
   for it; the credit comes from what the declaration can target.
2. **Typed services are a good idea HoBo already has** in Bindle kinds, and does not explain as
   clearly. Render's naming is more legible to a working developer than HoBo's vocabulary is.
3. **The simple case must stay simple.** Every product in this cohort proves that a compact file for
   a web app plus a database is the entry requirement.

## Sources

- [render.com/docs](https://render.com/docs) — service types, Blueprints, managed data, preview environments
- [render.com](https://render.com/) — positioning (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current pricing, region list and managed-service catalog were not
re-verified in this pass and are not asserted.
