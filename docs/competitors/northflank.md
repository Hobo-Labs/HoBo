---
type: Competitive Reference
title: "Northflank — competitor reference"
description: "Northflank is a **full-stack, self-service PaaS / cloud platform**: deploy services, jobs, cron, build pipelines, and managed databases (Postgres/MySQL/MongoDB/Redis/…) from one Kubernetes-native control plane — in Northflank's cloud **or bring-your-own-cloud** (AWS/GCP/Azure/Oracle/CoreWeave/Civo/on-prem) — with preview environments, JSON templates + bidirectional GitOps, a `northflank` CLI/API, and first-class GPU/AI workloads."
tags: [hobo, competitors]
competitor:
  slug: northflank
  name: "Northflank"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, self-hosted-paas]
  directness: overlapping
  role: "full-stack PaaS with BYOC and GPU support — mature container PaaS benchmark"
  posture: [benchmark]
  hobo_surface: [environments, delivery, governance]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://northflank.com/docs
    - https://northflank.com/features/platform
---

# Northflank — competitor reference

> A faithful, detailed capture of **Northflank** for HoBo competitive analysis. Northflank is a **full-stack, self-service PaaS / cloud platform** — *"Deploy any project in seconds, in our cloud or yours."* From one control plane you ship **services (long-lived containers), jobs, cron, build pipelines / release flows, and managed databases** (Postgres, MySQL, MongoDB, Redis, MinIO, Memcached, RabbitMQ), with **preview environments per PR**, **JSON templates as native IaC + bidirectional GitOps**, secrets/RBAC/observability, and first-class **GPU/AI workloads**. The distinguishing move versus most PaaS: Northflank runs either on **Northflank Cloud (managed)** *or* **Bring Your Own Cloud (BYOC)** — it provisions and manages **Kubernetes clusters inside your own AWS/GCP/Azure/Oracle/CoreWeave/Civo account or on-prem/bare-metal**, so the same platform experience runs on infrastructure you own. Northflank is a **shipping, commercial GA product operating at scale** (Northflank cites 130B+ requests, millions of containers, 330+ availability zones, 80k+ developers); HoBo is design-phase. Sources: [northflank.com](https://northflank.com/) · [features/platform](https://northflank.com/features/platform) · [features/bring-your-own-cloud](https://northflank.com/features/bring-your-own-cloud) · [features/infrastructure-layer](https://northflank.com/features/infrastructure-layer) · [docs](https://northflank.com/docs) · [Infrastructure as Code / templates](https://northflank.com/docs/v1/application/infrastructure-as-code/infrastructure-as-code) · [GitOps](https://northflank.com/docs/v1/application/infrastructure-as-code/gitops-on-northflank) · [CLI](https://northflank.com/docs/v1/api/use-the-cli) · [pipelines & release flow](https://northflank.com/docs/v1/application/release/create-a-pipeline-and-release-flow) · [GPU](https://northflank.com/gpu) · [pricing](https://northflank.com/pricing). Proprietary/commercial. Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Northflank is a **managed cloud platform / self-service PaaS** for shipping *"serious workloads"* — its pitch is *"Ship AI, services, databases, and jobs, securely. From commit to production and beyond."* You point Northflank at a Git repo (or a prebuilt image); it **builds, deploys, networks, scales, and operates** long-running **services**, one-off and scheduled **jobs**, **build pipelines / release flows**, and **managed databases**, all from a single dashboard, API, or CLI. The surface is broad by design: unlike a push-to-deploy PaaS that stops at web apps, Northflank bundles **CI/CD (pipelines, environment promotion, preview environments), a managed-database catalog (addons), GitOps, secrets, RBAC, observability, and GPU/AI compute** into one control plane.

The defining architectural choice — and the reason it is a distinct competitor from Render/Railway/Heroku — is **where the workloads run**. Northflank offers two deployment models with **identical platform functionality** (*"Same platform, everywhere"*): **Northflank Cloud** (Northflank's own managed infrastructure across North America, Europe, and Asia-Pacific) and **Bring Your Own Cloud (BYOC)**, where *"Northflank provisions and manages Kubernetes clusters within your … environment, handling upgrades, scaling, and maintenance."* In BYOC the workloads, databases, logs, and secrets stay in **your** cloud account — *"All application data, databases, logs, and secrets stay in your VPC"* and *"Northflank never has access to your workload data or secrets"* — while Northflank's **managed control plane** handles orchestration, deployments, scaling, and cluster lifecycle. BYOC is available **self-serve** into **AWS, GCP, Azure, Oracle Cloud, CoreWeave, and Civo**, plus **Bring Your Own Kubernetes (BYOK)** for **existing clusters, on-prem, or bare-metal**.

Under the hood Northflank is **Kubernetes-native but Kubernetes-abstracted**: *"projects map to Kubernetes namespaces with isolated networking and resource quotas,"* clusters/node-pools/autoscaling/maintenance windows are managed for you, and workloads are **containers** (any Docker image, Dockerfile, or buildpack). Isolation layers include **microVMs via Kata Containers or gVisor for VM-grade isolation** and a **service mesh with mutual TLS between workloads**. This is the categorical contrast with HoBo: Northflank's runtime substrate is **containers on Kubernetes on a single (its own) control plane**; HoBo's is a **language-neutral wasm/WIT runtime on a cloud-agnostic, event-sourced control plane** where self-host = hosted.

Authoring is **dashboard-first**, backed by a genuine **Infrastructure-as-Code** story that is *native* to Northflank: **JSON templates** (equivalently a drag-and-drop node editor) that describe *"resources, services, databases, pipelines, and integrations — everything you would otherwise configure manually,"* committed to Git with **bidirectional GitOps sync**. There is also a **`northflank` CLI**, a **REST API + JavaScript library**, and a **Terraform provider** for teams that prefer Terraform. Pricing is **consumption-based** (hourly compute + GPU + egress/disk, prorated to the second) with **no seat fees** on the self-service plan — a subscription/usage billing model that HoBo deliberately does not have ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

| Dimension | Northflank |
|---|---|
| Category | Full-stack **self-service PaaS / cloud platform** — services + jobs + pipelines + managed DBs + GPU, on **containers/Kubernetes**; Northflank operates the **control plane**, workloads run in **Northflank Cloud _or_ your cloud (BYOC)** |
| Authoring | **Dashboard-first** + **JSON templates** (native IaC; visual node editor ⇄ JSON) + **bidirectional GitOps** + **REST API + JS library** + **`northflank` CLI** + a **Terraform provider** |
| Workload types | **Services** (long-lived containers, HTTP endpoints, internal networking, health checks) · **Jobs** (one-off: migrations/batch/manual) · **Cron** (scheduled jobs) · **Build pipelines / release flows** |
| Managed data (addons) | **PostgreSQL · MySQL · MongoDB · Redis · MinIO · Memcached · RabbitMQ** — automated **backups + restore + fork**, PITR, **HA (primary+read-replica automated failover)** on PG/Redis, horizontal/vertical scaling, TLS, **pgvector**, connection poolers; connection details **injected via secret groups** |
| Runtimes | **Containers** — any Docker image / Dockerfile / buildpack; **Kubernetes-native** (projects = namespaces, node pools, quotas); **microVMs (Kata / gVisor)** for VM-grade isolation |
| Deploy model | **Git-push CI/CD**, build pipelines, **environment promotion** (*"promote the exact same configuration to production"*), **preview environments per PR** |
| Clouds | **Northflank Cloud** (managed; NA / EU / APAC) **or BYOC** — **AWS · GCP · Azure · Oracle · CoreWeave · Civo** self-serve + **BYOK** (on-prem / bare-metal); Northflank **provisions & manages Kubernetes in your VPC**; data stays in your account |
| GPU / AI | **18+ GPU types** (NVIDIA H100/H200/A100/B200/L40S/L4/T4, AMD MI300X, Habana Gaudi); inference endpoints **autoscale 0→N**, **MIG + time-slicing**, spot pricing; **microVM sandboxes** for agent/untrusted code |
| Isolation / security | Projects → **K8s namespaces** (isolated networking + quotas) · **microVMs (Kata/gVisor)** · **service-mesh mTLS** · **RBAC** (custom roles) · secrets **AES-256 at rest**, injected at runtime |
| License / price | **Proprietary, commercial**; **Sandbox** (free) / **Pay-as-you-go** (consumption-based, **no seat pricing**) / **Enterprise** (custom) — hourly compute (**$0.01667/vCPU/hr**, **$0.00833/GB/hr**) + **GPU hourly** + egress **$0.06/GB** + disk **$0.15/GB/mo**, prorated to the second |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Project** | The grouping for services, jobs, addons and pipelines |
| **Service** | A deployed workload built from Git or an image |
| **Job / cron job** | One-shot and scheduled workloads, first-class alongside services |
| **Addon** | A managed database or backing service (Postgres, MySQL, Mongo, Redis, MinIO, Memcached, RabbitMQ) with backups, PITR, fork and HA |
| **Secret group** | Shared configuration auto-wired into the services that reference it |
| **Pipeline / release flow** | Promotion between environments, with preview environments per pull request |
| **Template** | Northflank's own IaC: JSON templates that round-trip with the visual editor and support args, refs and functions |
| **BYOC cluster** | Kubernetes provisioned and managed by Northflank inside the customer's own cloud account |

The mental model is **one product for the whole backend**: compute, data, delivery and GPU in a
single catalog, expressible either visually or as templates, and runnable either on Northflank's
infrastructure or in the customer's account with the same behaviour.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `environments` | Environments, preview environments per PR, and promotion between them |
| `delivery` | Build pipelines and release flows in the same product as the runtime |
| `governance` | RBAC, audit and centralized observability |
| `finops` | Usage-based billing with GPU, egress and disk metered to the second |
| `extensibility` | Templates cover the whole platform surface, not a subset |

Northflank contests HoBo on **breadth of a shipping product**, not on application modelling: there is
no provider-abstract description and no scored placement. Its BYOC clusters are the closest analog to
HoBo Camps, but they are always Northflank-managed Kubernetes.

## Feature surface

### Workload model — services, jobs, cron

- **Services** — *"Services run as long-lived containers with HTTP endpoints, internal networking, and health checks."* A service builds from a connected Git repo (buildpacks or Dockerfile) or a prebuilt image, gets a public/internal endpoint, **autoscales** on CPU/memory/HTTP metrics (min/max replica counts), and is load-balanced with zero-downtime rollouts.
- **Jobs** — *"Run one-off jobs for migrations, batch processing, or manual tasks."* A job is a container that runs to completion; used for migrations, data processing, batch compute, and (with GPU) training/inference batches.
- **Cron** — *"Schedule recurring jobs with cron expressions for maintenance, reports, or data processing."* Scheduled variant of jobs.
- **Builds** — every service/job build is first-class: build from source (auto-detected buildpacks or a Dockerfile), cache layers, and feed the resulting image into pipelines/release flows.

### Managed databases (addons)

Northflank ships a **managed-database catalog** deployed as **addons** alongside your workloads: **PostgreSQL, MySQL, MongoDB, Redis, MinIO, Memcached, and RabbitMQ**. Per Northflank, addons *"provision in minutes via UI, API, or CLI"* and include:

- **Backups & recovery** — *"automated backups with restore and fork support"*; point-in-time recovery.
- **High availability** — PostgreSQL and Redis offer *"primary and read replicas with automated failover"*; Redis adds **Sentinel** + configurable eviction policies.
- **Scaling** — *"horizontal and vertical scaling"* without downtime, adjustable via UI, API, or CLI.
- **PostgreSQL specifics** — **pgvector** for AI similarity search, **connection poolers** for high-connection workloads, automated failover.
- **Security & wiring** — TLS included; *"connection details are injected directly into connected services via **secret groups**, with no manual environment variable management required."*
- **Preview databases** — *"isolated database instances per pull request"* torn down on merge; pause/restart for dev databases.

Crucially, in **BYOC these databases run inside your own VPC** — the managed-DB control plane lives with Northflank, but the data plane is your infrastructure.

### Bring Your Own Cloud (BYOC) & the infrastructure layer

BYOC is Northflank's headline platform-engineering feature. *"Northflank provisions and manages Kubernetes clusters within your … environment, handling upgrades, scaling, and maintenance,"* delivering *"the full platform experience — services, databases, jobs, GitOps, preview environments — running on infrastructure you own and control."*

- **Managed clusters in your account** — Northflank handles *"cluster provisioning, upgrades, scaling, and maintenance"* with *"automatic version updates with configurable maintenance windows."* You configure node pools, autoscaling policies, and multi-region distribution; Northflank keeps the clusters healthy.
- **Providers** — self-serve BYOC into **AWS · GCP · Azure · Oracle · CoreWeave · Civo**; **BYOK** imports *"existing clusters from any provider"* and covers **on-prem / bare-metal**.
- **Data residency & isolation** — *"All application data, databases, logs, and secrets stay in your VPC,"* and *"Northflank never has access to your workload data or secrets"* — positioned for GDPR / HIPAA / SOC 2 / ISO 27001 because data *"never crosses your cloud boundary."* Projects *"map to Kubernetes namespaces with isolated networking and resource quotas."*
- **Control-plane split** — the managed control plane handles *"deployments and scaling, orchestration metadata … cluster lifecycle operations (upgrades, maintenance),"* while the runtime/data plane lives entirely in your cloud. This is a **hosted control plane + your data plane** model — *not* a self-hostable control plane (you cannot run Northflank's control plane yourself).

### Templates as native IaC + GitOps

Northflank's IaC primitive is the **template** — *"native to Northflank,"* able to express *"the full range of Northflank-specific concepts including pipelines, release flows, and preview environments without needing a separate provider or plugin."* Templates are authored **visually (drag-and-drop node editor) or as JSON**, and the two are interchangeable.

```jsonc
// Illustrative Northflank template shape (JSON == visual node graph)
{
  "$schema": "https://api.northflank.com/v1/schemas/template",
  "name": "my-stack",
  "description": "services + database + release flow",
  "kind": "template",                    // "template" | "release-flow" | "preview-env"
  "arguments": { "region": "us-east", "IMAGE_TAG": "latest" },
  "spec": [                              // array of workflows / nodes
    {
      "kind": "Addon",                   // node kind: Service | Addon | Job | Project | …
      "ref": "db",
      "spec": { "type": "postgres", "version": "16", "plan": "nf-compute-100-2" }
    },
    {
      "kind": "Service",
      "spec": {
        "name": "api",
        "deployment": { "image": "myorg/api:${args.IMAGE_TAG}" },
        "secretRef": "${refs.db.connectionSecretGroup}"   // downstream node output
      }
    }
  ]
}
```

- **Dynamic configuration** — *"replace hardcoded values by template arguments, references to the output from a previous template node, and functions that are evaluated when the template is run"* — argument refs `${args.NAME}`, node-output refs, and functions like `${fn.toBase64(args.CONFIG_SECRET)}`. This lets one template deploy across regions/environments with different args.
- **Node graph** — a template is nodes (discrete actions: create a service, deploy a database, run a job) chained via output references; runs **manually or on GitOps triggers**.
- **Template kinds** — **team templates** (general provisioning), **release-flow templates** (pipeline automation), **preview-environment templates** (ephemeral per-PR). Schema endpoints: `.../v1/schemas/template`, `/release-flow`, `/preview-env`.
- **Bidirectional GitOps** — *"any changes to your template in your repository are automatically reflected on Northflank, and any changes you make in Northflank are committed to your repository on save, enforcing a single source of truth."* Northflank frames templates as filling *"a similar role"* to Terraform/Pulumi but native to Northflank's own concepts.

### Pipelines, release flows & preview environments

- **Pipelines** — *"Build sophisticated deployment pipelines with environment promotion, automated testing, and approval gates."* Resources are organized into **pipeline stages**.
- **Release flows** — *"a release flow for each stage of your pipeline, to automate your releases … deploy and promote builds, back up databases, and run jobs,"* triggered by Git or webhooks; *"replaces CI/CD for individual services and jobs."*
- **Environment promotion** — *"Promote workloads between environments with API calls or UI actions. Test in staging, then promote the exact same configuration to production."*
- **Preview environments** — *"full-stack preview environments for every pull request,"* created automatically on branch push / PR matching Git triggers, updated on subsequent commits, self-contained or sharing resources with a dev environment, torn down on merge.

### CLI, API & Terraform

```bash
npm i -g @northflank/cli        # or: yarn global add @northflank/cli   (Node v12+)

northflank login                # create a context; opens browser to select/create an API token
northflank context ls           # list contexts
northflank context use          # switch context; also: context use project|service|job (defaults)

# read/create resources — fully interactive, or pass params / files
northflank get service --project <PROJECT_ID> --service <SERVICE_ID>
northflank create service --file definition.yaml      # -f file | -i inline JSON/YAML
northflank get addon   | northflank create addon      # managed databases
northflank get job     | northflank create job
northflank --help | northflank command-overview
```

- **API & JS library** — the same operations are available over the **REST API** and a **JavaScript library**; CLI `create` bodies *"match API request bodies,"* so templates/CLI/API/UI all describe the same resource shapes.
- **Terraform** — Northflank documents a **Terraform provider** for teams that prefer Terraform tooling (a community implementation exists at `Vestmark/terraform-provider-northflank`, built on `terraform-plugin-framework`/protocol v6). Northflank's *primary* IaC path remains **native JSON templates + GitOps**, which it positions as expressing Northflank concepts *"without needing a separate provider or plugin."*

### Secrets, RBAC & observability

- **Secrets** — *"Environment variables and files encrypted at rest with AES-256. Secrets injected at runtime into containers."* Grouped into **secret groups** and auto-wired from addons into connected services.
- **RBAC** — *"Define custom roles with specific permissions for deployments, configuration, secrets, and billing."*
- **Observability** — centralized logs (*"stream logs from all services, jobs, and builds to a unified interface"*), CPU/memory/network/disk **metrics + built-in dashboards**, and **autoscaling** on CPU/memory/HTTP metrics.

### GPU & AI workloads

Northflank leans hard into AI/GPU as a differentiator:

- **GPU breadth** — *"18+ GPU types,"* including **NVIDIA H100, H200, A100, B200, L40S, L4, T4**, **AMD MI300X**, and **Habana Gaudi**, selectable per workload.
- **Inference** — deploy *"production inference endpoints for text generation, embeddings, or chat completions with auto-scaling from zero to hundreds of GPUs based on traffic,"* with batching + model caching.
- **GPU efficiency** — *"run multiple independent workloads on each provisioned GPU with time slicing and NVIDIA Multi-Instance GPU (MIG)"*; **spot pricing** for savings.
- **Sandboxes** — **microVM-based isolation** (Kata / gVisor) for *"teams running AI agents or sandboxed code,"* preventing cross-tenant access — a security boundary for untrusted/agent-generated workloads.

### Pricing

- **Sandbox (free)** — always-on compute, *"no sleeping"*; includes 2 free services, 1 free database, 2 free cron jobs.
- **Pay-as-you-go** — self-service, consumption-based; *"only pay for consumption,"* **no seat-based pricing** (*"teams included at no additional cost"*).
- **Enterprise** — custom pricing/invoice, volume discounts, annual commitments.
- **Compute (hourly)** — **$0.01667 / vCPU / hr**, **$0.00833 / GB / hr** (0.1–32 vCPU; 256 MB–256 GB); predefined plans e.g. `nf-compute-10` $2.70/mo, `nf-compute-100-2` $24.00/mo, `nf-compute-400` $96.00/mo.
- **GPU (hourly)** — NVIDIA **L4 24 GB $0.80/hr**, **A100 40 GB $1.42/hr**, **H100 80 GB $2.74/hr**; spot from **$2.74/hr** for H100.
- **Data / network** — egress **$0.06 / GB**, disk **$0.15 / GB / mo**; everything **prorated to the second**. (In BYOC you also pay your own cloud for the underlying infra.)

## Architecture

- **Control plane** — Northflank's hosted service, and **only** its hosted service: BYOC moves the
  data plane into the customer's account while orchestration stays with the vendor.
- **Data plane** — Kubernetes, either Northflank's or provisioned into the customer's AWS, GCP,
  Azure, Oracle, CoreWeave, Civo, on-prem or bare-metal capacity.
- **Execution model** — build from source or image, deploy to Kubernetes, manage addons as operated
  workloads, drive promotion through pipelines.
- **State authority** — Northflank's own model, with bidirectional GitOps keeping templates and
  platform state in sync. No event log, no decision replay.
- **Portability boundary** — BYOC gives the customer the *account*, not the *description*: templates
  are Northflank JSON, and the platform's catalog is its own. Leaving means rebuilding, though the
  clusters and data remain the customer's.

## Where Northflank is stronger

> Shipped, evidenced capability only.

### what Northflank does well

- **One control plane for the whole backend** — services, jobs, cron, build pipelines, managed databases, secrets, and GPU compute in a single, coherent product. Far broader than a push-to-deploy PaaS; closer to a private Heroku+CI+DBaaS+GPU cloud.
- **Genuine BYOC** — provisions and manages **Kubernetes in your own AWS/GCP/Azure/Oracle/CoreWeave/Civo account (or on-prem/bare-metal)** with *"same platform, everywhere,"* keeping data in your VPC. This is a real differentiator most PaaS competitors (Render/Railway/Heroku) lack.
- **Mature managed-database catalog** — Postgres/MySQL/Mongo/Redis/MinIO/Memcached/RabbitMQ with backups, PITR, **fork**, HA failover, scaling, pgvector, and **secret-group auto-wiring** — production-grade DBaaS bundled in.
- **Native IaC that covers the *whole* platform** — JSON templates (⇄ visual) + **bidirectional GitOps** express services, DBs, pipelines, release flows, and preview envs, with args/refs/functions — no separate IaC engine needed for Northflank concepts.
- **First-class AI/GPU** — 18+ GPU types, autoscale-to-zero inference, MIG/time-slicing, spot, and microVM sandboxes for agent/untrusted code — a strong, current AI-workload posture.
- **Strong ops surface** — pipelines, environment promotion, preview envs per PR, RBAC, centralized logs/metrics/autoscaling, and a full CLI/API/JS-library — at real production scale.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Northflank's limits — HoBo's opening

- **Container/Kubernetes-centric, not wasm** — the runtime substrate is **containers on Kubernetes**; there is no language-neutral component runtime, no capability-security-by-linking, no wasm-default polyglot model. HoBo's runtime is **wasm/WASI/WIT by default with OCI containers as a fallback** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) — portability at the component boundary, not the image boundary.
- **A single, proprietary control plane — Northflank's own.** BYOC moves the *data plane* into your cloud, but the **control plane is Northflank's hosted service** — you cannot self-host it, and there is no cloud-agnostic/pluggable-IaC layer *under* the platform (resource→backend mapping is Northflank's, over Kubernetes). HoBo is a **cloud-agnostic control plane with pluggable IaC** (Pulumi/Crossplane/Terraform/OpenTofu as adapters) where **self-host = hosted** — the Yard is itself a Bindle ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **No durable, event-sourced runtime.** Northflank orchestrates containers; there is no built-in **event store / actors / durable workflows / replay** as a first-class runtime. HoBo's data plane is an **event-sourced, replayable runtime** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No auditable platform-rules / Matching layer.** Placement is *"deploy this workload to this cluster/region,"* not *"same app → different realization per environment, auditably, cost/GPU-routed."* HoBo adds **Resource Definitions + Matching** (a recorded `match.Decided` decision) and a credit/budget-aware, **GPU-aware Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No agents-as-principals / no generation pipeline.** Northflank hosts AI *workloads* (a great GPU runtime) and offers microVM sandboxes, but agents are not **first-class platform principals** with brokered tokens + audit, there is no **MCP control surface**, and providers/implementations are **human-authored** — no AI generation/self-healing pipeline. HoBo makes agents principals with SVIDs + MCP ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) and **generates providers/impls** against conformance ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **Subscription/usage billing is core** — hourly compute + GPU + egress/disk, prorated to the second. HoBo has **no billing/subscriptions/monetization** — it is **✗-by-design** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); cost surfaces only as **OSS metering/showback FinOps** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)), not a revenue model.
- **Data catalog is DBaaS, not a paradigm taxonomy.** Northflank gives you managed *engines* (Postgres/Mongo/Redis/…); it does not model **relational/document/kv/cache/graph/vector** as a portable, overridable **port taxonomy**. HoBo formalizes a generic **`data`** port with paradigm behind Matching ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)), a distinct app-facing **`cache`** port ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)), and **opt-in paradigm packages** (`@hobo/sql`/`vector`/`graph`/`document`, [ADR-0081](../design/adr/03-data-plane.md#adr-0081)) mapping to cloud natives.
- **No cross-cloud data / adopt-in-place story.** BYOC provisions *new* Northflank-managed clusters; there is no documented migration/portability/consistency model across clouds, nor an "import my existing TF/Pulumi/FaaS estate" path. HoBo specifies app-data migration + cross-Camp consistency ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)/[ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) and **`hobo import`** adopt-in-place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **No multi-tenant-app primitives.** Northflank isolates *your* workloads (namespaces, microVMs, mesh mTLS) but gives a SaaS builder no **app-tenant model / tenancy spectrum / per-tenant isolation-routing-quota-residency-lifecycle**. HoBo ships this as a capability ([Plan 50](../design/security-networking.md#plan-50)/[ADR-0079](../design/adr/02-identity-security.md#adr-0079)/[ADR-0080](../design/adr/02-identity-security.md#adr-0080)).

## Adversarial critique

- **The control plane cannot be self-hosted.** BYOC relocates the data plane and leaves
  orchestration with the vendor, so the platform remains a hard runtime dependency for deploys,
  scaling and promotion no matter whose account the workloads run in.
- **Templates are a proprietary IaC.** They cover the platform completely and describe nothing
  outside it; the round-trip with the visual editor is convenient and makes the format the product's
  own.
- **BYOC provisions new clusters** rather than adopting existing estates, so the migration path is
  greenfield and the "same platform everywhere" claim assumes Northflank built the everywhere.
- **Managed addons are operated engines, not a portable taxonomy.** Postgres is Postgres; there is no
  abstraction over relational/document/kv/vector that would let a workload move between engines.
- **Usage billing scales with success**, including GPU-hours and egress, and preview environments per
  PR multiply exactly the resources that bill by the second.
- **Breadth is operational surface.** Databases with PITR and HA failover, GPU scheduling with MIG
  and time-slicing, and build pipelines are each substantial systems; the vendor operates them all,
  and the customer's leverage when one misbehaves is a support ticket.
- **Kubernetes is visible when it fails**, despite being hidden when it works.

### Comparisons with adjacent tools

- **vs HoBo:** Northflank is a **shipping, broad PaaS on containers/Kubernetes with real BYOC and GPU**, run from **its own control plane**, billed by usage. HoBo is a **design-phase, cloud-agnostic control plane + durable event-sourced wasm runtime**, IaC-agnostic, agent-native, self-host = hosted, and **no billing**. Northflank validates the *market* for "one platform for services+DBs+pipelines+BYOC+GPU"; HoBo's edge is the **substrate (wasm/WIT + pluggable IaC + multi-cloud), the governed/event-sourced control plane, the Matching/Dispatcher rules layer, and AI-native depth**. Northflank's BYOC (managed K8s in your VPC) is the closest analog to HoBo **Camps**, but HoBo Camps are cloud-agnostic placement targets, not Northflank-managed K8s.
- **vs Render / Railway / Heroku:** those are single-vendor managed PaaS (their infra only); **Northflank adds BYOC + a deeper managed-DB catalog + pipelines/release flows + GPU**, making it a heavier, more platform-engineering-shaped product than a pure push-to-deploy PaaS.
- **vs Encore / Nitric:** Encore/Nitric are **infrastructure-*from*-code** frameworks (declare resources inline in app code → provision AWS/GCP[/Azure/K8s]). Northflank is **infrastructure-*as*-code + a hosting platform** (JSON templates over Northflank's own catalog on Kubernetes) — you configure a platform rather than declare resources in your handlers. HoBo takes the IfC authoring model (like Encore/Nitric) **and** runs it on a governed multi-cloud control plane (broader than Northflank's single control plane).
- **vs Humanitec / Crossplane:** Northflank *is* the platform (opinionated, Kubernetes-native, hosted control plane) rather than a toolkit for building an internal developer platform on your own control plane. HoBo sits closer to the platform-engineering/orchestrator space but with a wasm runtime + event-sourced planes and no fixed K8s foundation.
- **vs Modal / GPU clouds:** Northflank's GPU/inference story overlaps the AI-compute clouds, but Northflank bundles it into a full app+DB+pipeline platform with BYOC, rather than being GPU-first only.

**Net:** Northflank is a **mature, broad, container/Kubernetes PaaS** whose standout is **real self-serve BYOC (managed K8s in your own cloud) + a deep managed-database catalog + native IaC/GitOps + first-class GPU** — a serious, shipping product where HoBo is design-phase. The differentiation is **not** breadth of PaaS features (Northflank wins there today); it is the **substrate and the planes**: a **language-neutral wasm/WIT runtime** (not containers-on-K8s), a **cloud-agnostic control plane with pluggable IaC** that is **self-hostable = hosted** (not one proprietary hosted control plane), a **durable event-sourced runtime**, an **auditable Matching + GPU/cost Dispatcher** rules layer, **agents-as-principals + a generation pipeline**, a **data-paradigm taxonomy** (not just managed engines), and **no billing model** (usage pricing is ✗-by-design, [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Northflank concept (✅ has · ➕ goes further · ◐ partial/thin · 🔜 planned). HoBo is **design-phase**; Northflank ships a mature full-stack PaaS at scale — credit that. Anchors point at the owning design docs.

| Northflank concept | HoBo equivalent | Status | Notes |
|---|---|---|---|
| **Services** (long-lived containers, HTTP, internal net, health checks) | `service` resource on the **wasm/WASI runtime** (OCI container fallback) behind `hobo:http`/`wasi:http` ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ | wasm-default polyglot + capability-by-linking; containers are a fallback, not the substrate |
| **Jobs** (one-off) + **Cron** | `hobo:job` (+ IaaS `vm`/`microVm`) + `hobo:scheduler` (control-plane cron) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | near 1:1 |
| **Managed databases** (Postgres/MySQL/Mongo/Redis/…) | generic **`data`** port, paradigm behind Matching ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)) + **opt-in paradigm packages** `@hobo/sql`/`vector`/`graph`/`document` ([ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ➕ | portable paradigm taxonomy mapped to cloud natives, overridable — not a fixed managed-engine catalog |
| **Redis / Memcached** (cache addons) | first-class app-facing **`cache`** port `hobo:cache` (ephemeral/TTL/evictable), distinct from durable `wasi:keyvalue` ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)) | ✅/➕ | HoBo separates cache from durable KV by design |
| Addon **backups / PITR / fork / restore** | app-data migration + snapshot/restore semantics ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) | ◐ | designed as data-migration/consistency, not a turnkey DBaaS backup UI (Northflank ships this now) |
| Addon **secret-group injection** | `.allow()` → **least-priv IAM + wasm link + token** (one decl, three effects) + `wasi:config/store`/`hobo:secrets` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[ADR-0113](../design/adr/02-identity-security.md#adr-0113)) | ✅/➕ | wiring is a capability grant, not just an env-var group |
| **BYOC** (managed K8s in your AWS/GCP/Azure/Oracle/CoreWeave/Civo VPC) | **Camps** as cloud-agnostic placement targets via provider adapters + **pluggable IaC** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ | multi-cloud + Pulumi/Crossplane/TF/OpenTofu adapters; K8s is one optional adapter, not the foundation |
| **Kubernetes-native** (projects = namespaces) | Kubernetes is **one optional execution adapter**, never the base ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ | HoBo does not fix any hosting tech; selected per workload via Matching |
| **microVM sandboxes** (Kata/gVisor) for agent/untrusted code | **sandbox lanes** (request-level isolation) ([ADR-0076](../design/adr/02-identity-security.md#adr-0076)) + wasm capability isolation ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ✅/➕ | isolation by construction (deny-by-default links) + microVM/OCI where needed |
| **JSON templates** (native IaC, visual ⇄ JSON, args/refs/functions) | **Manifest IR** from IfC authoring ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) + pluggable IaC adapters ([Plan 4](../design/control-plane.md#plan-04)) | ➕ | resources declared inline in code (IfC), lowered to a manifest IR; IaC engine is pluggable |
| **Bidirectional GitOps** | GitOps + progressive delivery via **The Harness** (OpenFeature/OpenDelivery/OpenExperiment) ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ✅/➕ | delivery is a pluggable core plane, not a template-sync feature |
| **Pipelines / release flows / environment promotion** | **The Harness** progressive delivery + platform-engineering rules ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)/[Plan 25](../design/platform-engineering.md#plan-25)) | ✅/➕ | promotion becomes a governed, auditable `can-deploy` decision |
| **Preview environments per PR** | **ephemeral / preview Camps** + sandbox lanes ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0076](../design/adr/02-identity-security.md#adr-0076)) | ✅ | full-stack ephemeral environments |
| **GPU / AI workloads** (18+ GPUs, inference, MIG, spot) | GPU/cost-aware **Matching + Dispatcher** routing ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) + `hobo:job` GPU | ➕ | HoBo *routes* GPU workloads by cost/credits/constraints across providers; Northflank *hosts* them (mature today) |
| **`northflank` CLI / REST API / JS library** | **`hobo` CLI** + SDK/API ([Plan 7](../design/developer-experience.md#plan-07)/[Plan 2](../design/sdk-api.md#plan-02)) | ✅ | same-shape resource CRUD across CLI/API/manifest |
| **Terraform provider** | Terraform/OpenTofu as **IaC adapters under** the control plane ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ | TF is a pluggable backend, not the top-level IaC |
| **RBAC** (custom roles) | governance/policy planes + deny-by-default control-plane decisions ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ✅/➕ | RBAC over the platform itself + contracts/`can-deploy` |
| **Logs / metrics / autoscaling** | observability + operations dashboard ([Plan 5](../design/reliability-observability-cost.md#plan-05)/[Plan 49](../design/developer-experience.md#plan-49)) | ✅ | multi-cloud/multi-env fleet view |
| **Managed control plane (Northflank's own, hosted)** | **cloud-agnostic, event-sourced control plane**, self-hostable = hosted ([Plan 4](../design/control-plane.md#plan-04)/[Plan 11](../design/data-plane.md#plan-11)) | ➕ | you run the whole control plane; audit/replay built in |
| **Subscription / usage pricing** (hourly compute+GPU+egress) | **✗ by design** — no billing/subscriptions/monetization ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); cost = OSS metering/showback ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗ | deliberate non-goal — HoBo is not a commercial hosting business |
| *(none — human-authored providers)* | **AI generation pipeline** — generated/repaired/certified providers & impls ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) | ➕ | net-new |
| *(none — AI as hosted workload only)* | **agents as first-class principals** + MCP control surface ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ | net-new |
| *(none)* | **Multi-tenant-app primitives** ([Plan 50](../design/security-networking.md#plan-50)) | ➕ | app-tenant model + tenancy spectrum + isolation by construction |
| *(none)* | **Durable event-sourced runtime + audit/replay** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)) | ➕ | net-new |
| *(none — greenfield BYOC clusters)* | **`hobo import`** adopt-in-place migration ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ | adopt existing TF/Pulumi/FaaS estates incrementally |

### The one-line takeaway

**Northflank proves the market for a broad, self-service, container/Kubernetes PaaS with real BYOC (managed clusters in your own cloud), a deep managed-database catalog, native IaC/GitOps, pipelines, and first-class GPU/AI** — and it ships that at scale today, where HoBo is design-phase. HoBo's differentiation is **not** PaaS breadth but the **substrate and the planes**: a **language-neutral wasm/WIT runtime** (not containers-on-K8s), a **cloud-agnostic control plane with pluggable IaC that is self-host = hosted** (not one proprietary hosted control plane), a **durable event-sourced runtime**, an **auditable Matching + GPU/cost Dispatcher** rules layer, a **portable data-paradigm taxonomy** (not just managed engines), **agents-as-principals + a generation pipeline**, and a deliberate **no-billing** posture (subscription/usage pricing is ✗-by-design, [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Better-together / integration posture

- **Benchmark** — Northflank is the breadth bar for a container PaaS: services, jobs, databases,
  pipelines, previews, BYOC and GPU in one coherent product. HoBo should not try to match that list.
- **Borrow** — **secret groups that auto-wire into referencing services** is a small, well-judged
  ergonomic HoBo's wiring model can learn from, and **database fork** as a first-class operation is
  the right primitive for preview environments that need real data.
- **Provider-target** — a Northflank BYOC cluster is a reasonable Camp substrate.
- Not an adopt or displace target: HoBo's argument is the layer above, and pretending to compete on
  managed-database depth would be a mistake.

## Threats and lessons

1. **Breadth is a real moat for the mid-market.** A team that wants services, databases, pipelines
   and GPU from one vendor has a good answer today. HoBo's counter is not more features but a
   description that outlives the vendor.
2. **BYOC without a self-hostable control plane is the industry norm**, and it is the specific gap
   HoBo's "self-host equals hosted" posture addresses. That contrast is sharper than any feature
   comparison and is under-used in HoBo's positioning.
3. **Database fork is the missing primitive for credible preview environments** — the second corpus
   occurrence of this finding after Upsun's data cloning, and worth its own implementation issue.
4. **GPU scheduling is now table stakes for a general platform**, not a specialist feature.

## Sources

- [northflank.com/docs](https://northflank.com/docs) — services, jobs, addons, pipelines, templates, BYOC
- [Platform features](https://northflank.com/features/platform) — breadth of the product surface
- [northflank.com](https://northflank.com/) — positioning, BYOC and GPU claims (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current pricing, GPU inventory and BYOC provider list were not
re-verified in this pass and are not asserted.
