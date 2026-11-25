---
type: Competitive Reference
title: "Qovery — competitor reference"
description: "Qovery is an **internal developer platform / self-service infrastructure-automation product** that deploys into **your own cloud account** (BYOC) — positioned as *\"the Kubernetes cont"
tags: [hobo, competitors]
competitor:
  slug: qovery
  name: "Qovery"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, platform-orchestrators]
  directness: direct
  role: "BYOC internal developer platform deploying into your own cloud — PaaS/IDP competitor"
  posture: [displace, benchmark]
  hobo_surface: [environments, delivery, provider-matching]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://www.qovery.com/docs
    - https://github.com/Qovery/engine
---

# Qovery — competitor reference

> A faithful, detailed capture of **Qovery** for HoBo competitive analysis. Qovery is an **internal developer platform (IDP) / self-service infrastructure-automation product that deploys into *your own* cloud (BYOC)**: it provisions Kubernetes + cloud resources in your AWS/GCP/Azure/Scaleway account, gives every pull request a full-stack **preview environment**, and drives it all from a console/CLI/API/Terraform/MCP surface — the closest **PaaS/IDP-shaped** competitor to HoBo's control plane. Sources: [qovery.com](https://www.qovery.com/) · [qovery.com/docs](https://www.qovery.com/docs) · [github.com/Qovery/engine](https://github.com/Qovery/engine) · [qovery.com/product/deploy](https://www.qovery.com/product/deploy) · [qovery.com/product/provision](https://www.qovery.com/product/provision) · [qovery.com/ai-devops-copilot](https://www.qovery.com/ai-devops-copilot) · [qovery.com/docs/terraform-provider](https://www.qovery.com/docs/terraform-provider/overview) · [qovery.com/solutions/ephemeral-environments](https://www.qovery.com/solutions/ephemeral-environments) · [qovery.com/pricing](https://www.qovery.com/pricing) · [security architecture](https://www.qovery.com/blog/qoverys-security-architecture-how-we-secure-your-cloud-kubernetes-infrastructure). License: the **Qovery Engine is open-source (GPL-3.0)**; the **Qovery platform/control plane is a commercial SaaS subscription** (self-host is Enterprise-only). Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Qovery is an **internal developer platform / self-service infrastructure-automation product** — currently marketed as *"the Agentic Infrastructure Platform"* and *"the Kubernetes control plane for humans and AI agents."* Unlike a managed PaaS (Render/Railway/Heroku) that runs your app in the **vendor's** cloud, Qovery deploys into **your own cloud account** (**BYOC — Bring Your Own Cloud**): it uses **Terraform/OpenTofu** to provision Kubernetes clusters, registries, load balancers, VPCs, and cloud resources in **your AWS, GCP, Azure, or Scaleway (beta)** account "in less than 30 minutes," or connects to a cluster you already run (**BYOK — Bring Your Own Kubernetes**). Either way, per Qovery, "you retain full ownership of your data and underlying resources."

The mental model is a **split control-plane / data-plane architecture**. The **control plane** is Qovery's SaaS backend (hosted on AWS `us-east-2`, written in **Kotlin/Java 17 + Rust**) where you declare desired state via **Console, CLI, REST API, Terraform provider, or MCP**. The **data plane** — your Kubernetes clusters, VPCs, apps, and databases — lives in your account. Two Rust components run **inside your cluster**: the **Qovery Engine** (open-source, GPL-3.0) "pulls a task from the control plane, generates all the configuration files (Terraform, Helm, and others), and bootstraps the full infrastructure on the target remote cloud account" to reach desired state (self-remediating on failure); the **Agent** (a Rust service in the `qovery` namespace) "forwards the app logs from Loki, retrieves Kubernetes metrics, and states to the Control Plane." Critically, **the Engine initiates the connection outbound** ("Metadata is sent over gRPC/TLS") — the control plane never reaches *into* your cloud — and **each cluster is autonomous**: "in case of a failure of the Qovery control plane … the customer infrastructure and Kubernetes cluster are not impacted." This pull-based, autonomous-cluster design is what lets one control plane "manage thousands of Kubernetes clusters."

Above that runtime, Qovery presents a developer-facing object model — **Organization → Project → Environment → Services** — where **the Environment is the deployable unit**: "Containers, Terraform modules, managed databases, Helm charts — deployed together, rolled back together." Services can be **applications** (Git-backed, built with Buildpacks or a Dockerfile), **containers** (any OCI image), **managed databases** (RDS/Cloud SQL or in-cluster; PostgreSQL/MySQL/MongoDB/Redis), **Helm charts**, **Terraform services/modules**, **cron jobs**, and **lifecycle jobs** (generic tasks run at environment start/stop/delete — e.g. seed a DB, create external resources). Every pull request can get an **ephemeral preview environment** — a full-stack clone (apps + databases + seeded data + real TLS + real URLs) auto-created, kept in sync per commit, and destroyed on merge/close. This is a mature, production BYOC IDP shipping at scale — HoBo is in the **design phase** and should credit it as such.

| Dimension | Qovery |
|---|---|
| Positioning | **Internal developer platform / "agentic infrastructure platform"** — *"the Kubernetes control plane for humans and AI agents"* |
| Model | **BYOC** (deploy into *your* cloud account) + **BYOK** (connect *your* existing Kubernetes) — "you retain full ownership of your data and underlying resources" |
| Clouds | **AWS · GCP · Azure · Scaleway (beta) · on-premise / self-hosted K8s** |
| Provisioning | **Terraform/OpenTofu + Helm + Kubernetes**; the **Qovery Engine** (open-source, Rust, **GPL-3.0**) bootstraps clusters + cloud resources to desired state, self-remediating |
| Control model | **Split-plane**: SaaS **control plane** (AWS `us-east-2`, Kotlin/Java + Rust) ↔ **data plane** in your account; **Engine + Agent pull tasks outbound** over gRPC/TLS; each cluster **autonomous** (survives control-plane outage) |
| Deployable unit | the **Environment** — apps + DBs + jobs + Helm + Terraform "deployed together, rolled back together" |
| Service types | **application** (Git; Buildpacks/Dockerfile) · **container** (any OCI) · **managed database** (RDS/Cloud SQL/in-cluster; PG/MySQL/Mongo/Redis) · **Helm** · **Terraform** service · **cron job** · **lifecycle job** |
| Interfaces | **Console (Web UI) · CLI · REST API · Terraform provider · MCP server · TS/JS/Go client libraries** |
| Preview envs | **ephemeral per-PR clones** (apps + DBs + seeded data + real TLS/URLs); updated per commit; auto-destroyed on merge/close; paused when idle |
| AI | **DevOps Copilot** + **MCP server** + "AI Skill" — external agents (Claude/Cursor/Codex/Gemini) provision/deploy/scale via natural language, **within RBAC + audit** |
| RBAC / audit | Owner/Admin/Maintainer/Billing/Reader + **custom roles** (cluster & project/env-type scope) · SSO (SAML/OIDC) group→role mapping · immutable **audit logs** · **SOC2 Type II** / HIPAA / GDPR |
| License / price | **Engine GPL-3.0 (OSS)**; platform is a **paid SaaS subscription** — Team **$899/mo** · Business **$1,999/mo** · Enterprise custom (self-host); AI agent seats **$10/mo** each |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Organization / Project** | The tenancy and grouping boundaries |
| **Cluster** | A Kubernetes cluster Qovery provisions and operates inside the customer's AWS, GCP, Azure or Scaleway account |
| **Environment** | A deployable unit containing applications, containers, managed databases, Helm charts, Terraform modules, cron and lifecycle jobs — "deployed together, rolled back together" |
| **Preview environment** | A full-stack per-pull-request clone including databases and seeded data, synced per commit and destroyed on merge |
| **Engine** | The open-source (GPL-3.0, Rust) provisioning core built on Terraform/OpenTofu, Helm and Kubernetes |
| **Agent** | The in-cluster component connecting outbound-only to the control plane |

The mental model is **operations abstracted, application unchanged**: Qovery takes over provisioning,
deployment, previews and day-2 operations, while the application itself remains containers, Helm
charts and Terraform modules on Kubernetes.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `environments` | **The sharpest contest.** Full-stack preview environments with cloned databases are the bar HoBo's ephemeral Camps target |
| `provider-matching` | Cluster placement across four clouds, chosen per cluster rather than scored per workload |
| `delivery` | Environment-scoped deploy and rollback as one transaction |
| `governance` | RBAC, SSO group mapping, immutable audit, SOC2 Type II / HIPAA / GDPR |
| `identity-secrets` | Outbound-only agent connectivity with short-lived STS tokens |
| `agent-surface` | An MCP server that lets external agents drive real infrastructure inside RBAC and audit |

Qovery is HoBo's sharpest PaaS/IDP-shaped competitor precisely because it has already proven two of
HoBo's bets in production: BYOC, and preview environments per pull request.

## Feature surface

### BYOC / BYOK — deploy into your own cloud

Qovery's headline is **"deploy on your own cloud."** It provisions with a single click: "Deploy Kubernetes clusters, registries, load balancers, and all essential components in less than 30 minutes." Two onboarding paths:

- **Managed provisioning (BYOC):** Qovery runs **Terraform/OpenTofu** to create the Kubernetes cluster + supporting cloud resources (VPC, registry, load balancers, node pools) in your **AWS / GCP / Azure / Scaleway (beta)** account. "Skip the complexity of day-1 setup and get a state-of-the-art infrastructure instantly."
- **BYOK (Bring Your Own Kubernetes):** "connect your existing cluster to Qovery" — Qovery deploys onto a cluster you already operate.

Cloud credentials stay least-privilege: "On compatible cloud platforms, Qovery uses **short-lived tokens** to connect to your IaaS tenant, e.g. using **STS for AWS**," and "each Qovery deployment job requires only a limited subset of an organization's secrets." Because provisioning is Terraform-based and the running services are ordinary Kubernetes workloads, "once a service is deployed by Qovery, it is set-up once and for all. Qovery services are not needed to keep it running."

### The control-plane / Engine / Agent model

```
You (Console · CLI · API · Terraform · MCP)
  → Qovery Control Plane (SaaS, AWS us-east-2; Kotlin/Java + Rust)   ← desired state
       ↑ outbound gRPC/TLS (Engine initiates; no inbound to your cloud)
  → Qovery Engine (OSS, Rust, GPL-3.0)  — pulls task → generates Terraform/Helm/K8s manifests → bootstraps to desired state, self-remediates
  → Qovery Agent (Rust, `qovery` namespace) — forwards Loki logs + K8s metrics/state back to control plane
  → your Kubernetes cluster(s) + cloud resources (autonomous; survive control-plane outage)
```

The **Engine** is open-source ([`github.com/Qovery/engine`](https://github.com/Qovery/engine), GPL-3.0, Rust): "an open-source abstraction layer library that turns easy application deployment on AWS, GCP, Azure, and other Cloud providers in just a few minutes," leveraging **Terraform, Helm, Kubectl, and Docker**. It "translates your application configurations into native Kubernetes manifests." Each cluster "only picks up instructions from the control plane to execute" and "does not rely on Qovery Control Plane," which is how Qovery scales horizontally to "thousands of deployments per day" across many clusters from one control plane.

### Environments & the service model (the deployable catalog)

The **Environment** is the unit of deploy/rollback and holds a graph of heterogeneous services:

- **Application** — Git-backed; built with **Buildpacks or a Dockerfile**; multi-language.
- **Container** — "Any OCI image," from your registry or Qovery's.
- **Managed database** — "PostgreSQL, MySQL, MongoDB, Redis" in **container mode** (in-cluster) or **cloud-managed mode** (RDS / Cloud SQL / equivalent).
- **Helm** — "deploy any helm chart from a git repository or helm repository directly on the kubernetes cluster."
- **Terraform** service — run a Terraform module as a first-class environment service (provision external/managed resources — Redis, S3, Stripe webhooks — alongside apps).
- **Cron job** — "a type of workload that runs on a Kubernetes cluster on a regular schedule."
- **Lifecycle job** — "a generic task to be executed at environment start/stop/delete … useful for tasks such as seeding a database or creating external resources."

Deployment adds **deployment stages/pipeline** ordering, **canary / blue-green** strategies, and "one-click rollback that reverts the whole environment." Qovery orchestrates on top of your CI ("GitHub Actions, GitLab CI, Jenkins, CircleCI — or no CI at all," plus an **ArgoCD bridge**) and supports monorepos ("Nx / Bazel … affected-only deploys").

### Preview / ephemeral environments

The flagship developer feature. "A preview environment is an **ephemeral environment associated with the life cycle of a pull request**." Qovery "automatically creat[es] a clone of your production environment (including applications, databases and configuration) on every pull request." Behavior:

- On PR open, "a new ephemeral environment will be provisioned and a **comment will appear on the pull-request indicating the environment's URL**, ready for testing" (`< 30 seconds typical`).
- "Qovery keeps your preview environments **up to date on every commit** and automatically **destroys them when the original pull request is merged or closed**."
- "Ephemeral environments are … **paused when not in use**, ensuring you never pay for unused resources."
- "Give every pull request its own full-stack environment — apps, databases, queues, seeded data, real TLS, real URLs."

### Interfaces — Console, CLI, API, Terraform, MCP

Qovery exposes the same object model through five surfaces: "the CLI, API, Web UI, Terraform provider, or client libraries in Typescript, JavaScript, GO."

**CLI** (`qovery`) — "interact with Qovery directly from your terminal to deploy applications, manage environments, stream logs, and more":

```bash
qovery version                         # verify installation
qovery auth                            # authenticate
qovery context set | list              # select org/project/environment context
qovery project list                    # list projects
qovery environment list                # list environments
qovery environment deploy --environment production   # deploy a whole environment
qovery environment deploy --containers --lifecycles --cronjob  # deploy multiple services at once
qovery deploy                          # ship current branch (auto-detect commit, or --commit/--tag)
qovery application deploy [--watch]     # deploy a Git application
qovery container  deploy [--watch]     # deploy a container service
qovery cronjob    deploy [--watch]      # deploy a cron job
qovery lifecycle  deploy [--watch]      # deploy a lifecycle job
qovery log                             # stream stdout/stderr live; filter by service, follow deploys
qovery shell                           # "interactive session inside any running container … without kubectl or kubeconfig"
qovery port-forward                    # port-forward local ↔ any app / cronjob / lifecycle / database
# service commands support list · deploy · redeploy · stop · delete · cancel
```

**Terraform provider** — "Define, provision, and manage your applications, databases, environments, and entire stacks declaratively with Terraform," version-controlled alongside app code:

```hcl
provider "qovery" { token = var.qovery_api_token }

# resources: qovery_project · qovery_environment · qovery_cluster
#            qovery_application · qovery_container · qovery_database
#            qovery_job (cron & lifecycle) · qovery_helm
# qovery_database provisions "PostgreSQL, MySQL, MongoDB, Redis" in container or cloud-managed mode

terraform import qovery_application.my_app <application-id>   # adopt existing resources
```

### AI / DevOps Copilot

Qovery's "agentic" pitch is an **MCP server + "AI Skill"** that lets external agents (**"Claude, Cursor, Codex, Gemini CLI, and others"**) "operate infrastructure through natural language commands" — e.g. *"spin up a preview env," "scale worker-api to 6," "create a staging database."* The value framing: "instead of juggling five disconnected tools [CI/CD, Kubernetes, Terraform, secrets, monitoring], agents can provision, deploy, and manage full-stack isolated environments with a single call" against Qovery's unified API. Crucially, agents are **governed, not autonomous**: "Guardrails live at the deployment level, so they apply to agents and engineers alike" — agents "execute within existing RBAC permissions," "cannot bypass governance guardrails," "cannot make unattributed changes (all actions audited)," and every change is "reversible via built-in rollback." A **DevOps Copilot** chat also assists humans. Pricing meters **AI agent seats** (bundled per tier; **$10/mo** each beyond).

### RBAC, governance & audit

- **Default roles:** **Owner** (one per org, full access), **Admin** (full access, cannot delete org), **Maintainer** (manage infra + deployments), **Billing Manager**, **Reader** (read-only).
- **Custom roles:** "fine-tune access control" at **cluster level** and **project level**; per **environment type** (development / staging / production / preview) you pick **No Access · Read-Only · Deploy · Manage · Full Access**.
- **SSO:** SAML/OIDC on Business+; "automatically maps IdP groups to roles."
- **Audit logs:** "any call happening on our API for your organization" is "logged in an immutable database" capturing "who, the what, the when, and even the how" — fields **Target Type · Target · Change · User · Tool**.
- **Compliance:** **SOC2 Type II** (Oct 2025), HIPAA & GDPR posture, at-least-yearly pen-testing; per-customer PBKDF encryption key backed by AWS KMS.

### Pricing (subscription)

Qovery is sold as a **flat-rate SaaS subscription** ("a predictable rate … which includes a specific allocation of team users, AI agent seats, managed clusters, and deployment minutes") — **cloud/infra costs are separate and paid to your provider**:

- **Team — $899/mo:** 10 users + 10 AI agent seats, 2 managed clusters, up to 100 environments, 5,000 deployment minutes, business-hours support; deploy-on-own-cloud, auto-scaling, wildcard domains.
- **Business — $1,999/mo (Popular):** 30 users + 30 AI agent seats, 3 managed clusters, up to 250 environments, 10,000 deployment minutes, **SLA 99.9%**, **SSO (SAML/OIDC)**, "Policy as code," AI Builder Portal add-on, advanced monitoring.
- **Enterprise — custom annual contract:** unlimited users/seats, **on-premise or self-hosted** option, custom clusters/environments/minutes, 24/7 support + dedicated CSM.
- **Add-on:** additional AI agent seats **$10/mo each**; AWS Marketplace listing; free trial.

## Architecture

- **Control plane** — Qovery's SaaS, holding environment definitions, RBAC, audit and preview
  orchestration.
- **Data plane** — Kubernetes clusters in the customer's own cloud accounts.
- **Connectivity** — the notable design: Engine and Agent connect **outbound only**, with no inbound
  path into the customer's cloud, using short-lived STS tokens and scoped secrets.
- **Failure posture** — clusters are **autonomous**: they keep running through a control-plane
  outage, which is a materially better answer than most hosted control planes give.
- **Execution model** — the Rust Engine drives Terraform/OpenTofu and Helm; provisioning primitives
  are standard and inspectable.
- **State authority** — Qovery's control plane plus Terraform state. Control-plane API calls are
  audited; application state is not an event log.
- **Portability boundary** — the customer keeps clusters and data; the environment model, previews
  and RBAC are Qovery's.

## Where Qovery is stronger

> Shipped, evidenced capability only.

### what Qovery does well

- **Mature, production BYOC at scale** — genuinely deploys into *your* AWS/GCP/Azure/Scaleway account and runs "thousands of Kubernetes clusters" from one control plane. This is a proven, shipping product; HoBo's equivalent (Camps on pluggable providers) is **design-phase**.
- **Excellent security/reliability posture from the split-plane, pull-based design** — Engine/Agent connect **outbound only** (no inbound path into your cloud), short-lived STS tokens, scoped secrets, and **autonomous clusters** that keep running through a control-plane outage. A strong trust model for BYOC.
- **Open-source Engine (GPL-3.0, Rust)** built on the boring-and-reliable stack — **Terraform/OpenTofu + Helm + Kubernetes** — so the provisioning primitives are inspectable and standard.
- **Best-in-class preview/ephemeral environments** — full-stack per-PR clones (apps + DBs + seeded data + real TLS/URLs), synced per commit, auto-destroyed on merge, paused when idle. This is the bar HoBo's ephemeral/preview Camps target.
- **Broad, unified service model** — apps, containers, managed DBs, **Helm**, **Terraform modules**, cron, and lifecycle jobs all live in one environment, "deployed together, rolled back together."
- **Five first-class interfaces** — Console, CLI, REST API, **Terraform provider**, and **MCP server** — with `terraform import` to adopt existing resources.
- **Enterprise governance that ships today** — custom RBAC (cluster/project/env-type), SSO group mapping, immutable audit logs, and **SOC2 Type II / HIPAA / GDPR**.
- **Credible agentic surface** — an MCP server that lets external coding agents drive real infra **inside** RBAC + audit + rollback, not just chat.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Qovery's limits — HoBo's opening

Anchored to HoBo design docs; HoBo is **design-phase**, so these are *architectural* openings, not shipped-vs-shipped wins.

- **Kubernetes-centric on your cloud — not cloud-abstracted at the *app model*.** Qovery abstracts **operations** (provision K8s, deploy environments, previews), but the app itself is still **containers + Helm charts + K8s manifests + Terraform** bound to Kubernetes. There is no language-neutral component/capability contract; portability is "runs on K8s in any cloud," not "the same app targets a non-K8s host." HoBo surfaces **WIT/wasm ports** so the app model itself is cloud-abstracted, with K8s/bare-metal as *one* host among many ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **Not wasm — container/Helm/K8s runtime.** No polyglot-via-components, no capability-based security at the runtime boundary. HoBo is **wasm/WASI-default** (any language → component, deny-by-default by linking) ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).
- **No durable event-sourced runtime.** Qovery audits **control-plane API calls** (who/what/when/how), but there is **no replayable application event log** — no actors, durable workflows, choreography sagas, or replay/audit of *app state*. HoBo's data plane is event-sourced (commands→events; backends are projections) with actors + workflows + sagas + replay ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No auditable Matching / Resource Definitions.** The resource→cloud realization is **Engine + Terraform-module driven**; you tune config, but there is no recorded per-environment *decision* ("cheap preview vs HA prod") as a first-class, cost-routed artifact. HoBo makes it a recorded **`match.Decided`** via **Resource Definitions + Matching** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) with a credit/budget-aware **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **Agents are shallow — a copilot + MCP over Qovery's API, not agents-as-principals.** Agents inherit a *human's* RBAC through the MCP surface; they are not **first-class identities** with their own SVIDs, a Capability Manifest, and brokered per-call tokens. HoBo makes agents principals with cryptographic identity + scoped, audited capability grants ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **No generation pipeline.** Provider/cloud breadth is **human-built** (Engine adapters + Terraform modules); there is no AI-generated provider/implementation path and no trainable/self-optimizing functions. HoBo's generation pipeline generates adapters + impls (stub → implement → trace → evolve, gated) ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **Not infrastructure-from-code.** Services are declared via **Console / API / Terraform / config**, not **inline in application code** with a single `.allow()` that drives IAM + runtime wiring + token scope together. HoBo's IfC authoring collapses declaration, least-privilege, and wiring into one in-code decl (one declaration, three effects) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **Self-host is Enterprise-only.** The **OSS Engine is a library**; the control plane, console, preview-environment orchestration, RBAC, and audit live in the **paid SaaS** — self-hosting the platform is a custom Enterprise contract. HoBo's **Yard is itself a Bindle**: self-host = hosted parity, OSS end-to-end ([Plan 4](../design/control-plane.md#plan-04)).

**On pricing — not a gap, a deliberate divergence.** Qovery's **subscription pricing** (Team $899 / Business $1,999 / Enterprise custom, plus AI-seat add-ons) is a sound commercial model for a hosted IDP. HoBo puts **monetization/billing out of design scope by decision** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); the only cost surface HoBo designs is **metering/showback as OSS FinOps** — so this is ✗-**by-design**, not a deficiency in Qovery.

## Adversarial critique

- **Self-hosting is Enterprise-only in practice.** The open-source Engine is a library; the control
  plane, console, preview orchestration, RBAC and audit are the paid SaaS. "Open source" describes a
  component, not the platform.
- **Kubernetes is the app model's floor.** Qovery abstracts operations, not the application:
  containers, Helm and Terraform remain what the developer maintains, so portability means "runs on
  Kubernetes in another cloud".
- **Preview environments with seeded data carry the same compliance hazard** as any production-data
  cloning, and the responsibility for sanitization sits with the customer.
- **Cluster-level cost floor.** Thousands of managed clusters is an impressive operational claim and
  also a reminder that the unit of adoption is a cluster, which small workloads cannot amortize.
- **The MCP surface inherits a human's RBAC.** Agents act as delegated users rather than as
  principals with their own identity and scoped grants — governed, but not independently
  attributable.
- **Four clouds is not cloud abstraction.** Each cluster lives in one account in one cloud; nothing
  moves between them.
- **Terraform inheritance** brings state, drift and provider-version friction into an otherwise
  managed experience.

### Comparisons with adjacent tools

- **vs HoBo:** Qovery is a **BYOC Kubernetes IDP** — mature ops (provision/deploy/preview/observe/optimize/secure) over containers/Helm/K8s in your cloud, sold as SaaS. HoBo is an **AI-native meta-cloud**: a cloud-agnostic control plane + a **durable, event-sourced wasm runtime**, where the app model is language-neutral WIT ports, realization is auditable Matching, agents are principals, and providers can be AI-generated. Qovery validates the **BYOC + preview-environment** thesis in production; HoBo's edge is **depth below the ops layer** (runtime, data, agents, generation) and **breadth beyond K8s**.
- **vs [Encore](encore.md):** both deploy into *your* cloud (no vendor-runtime lock-in). Encore is **infrastructure-from-code in TS/Go** (declare resources in app code; AWS/GCP managed services) with superb local DX; Qovery is **config/console/Terraform-driven**, **language-agnostic** (any container), spans **more clouds** (+ Azure/Scaleway/on-prem), and adds **K8s day-2 ops + preview environments** Encore doesn't emphasize. Encore is closer to HoBo's *authoring* model; Qovery is closer to HoBo's *platform/ops + BYOC* model.
- **vs [Nitric](nitric.md):** both are multi-cloud. Nitric is **IfC + a gRPC membrane + Pulumi/Terraform provider plugins**, portable at the *app-primitive* level; Qovery is **not IfC** — it is a **Kubernetes control plane + Terraform engine** that operates infra, with a richer ops/preview/RBAC story but a K8s-bound runtime.
- **vs [Humanitec](humanitec.md):** both are IDPs / platform orchestrators, but Humanitec centers a **Platform Orchestrator + Score** spec and resource-definition graph; Qovery bundles the **runtime (K8s), the engine (Terraform/Helm), and the developer surface** into one opinionated BYOC product with previews. HoBo's Resource Definitions + Matching are the closest analog to Humanitec's resource-definition idea, made **event-sourced and cost-routed**.
- **vs [Render](render.md) / [Railway](railway.md) / [Heroku](heroku.md):** those are **managed PaaS** that run your app in the **vendor's** cloud; Qovery runs the same class of workload in **your** cloud (BYOC) — you own the data-plane account and bill your provider directly.
- **vs Terraform / Pulumi:** Qovery **sits on top of** Terraform/OpenTofu — it is not a replacement — adding a Kubernetes IDP, preview environments, RBAC, and an agent surface over IaC primitives. HoBo likewise keeps IaC as **pluggable adapters** *under* the control plane ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).

**Net:** Qovery is HoBo's sharpest **PaaS/IDP-shaped** competitor and the clearest production proof of two HoBo bets — **BYOC (deploy into the customer's cloud)** and **ephemeral preview environments per PR** — plus mature K8s day-2 ops, RBAC, and audit that HoBo has only *designed*. The opening is **everything below and around the ops layer**: Qovery abstracts *Kubernetes operations in your cloud*; HoBo abstracts *the application itself* (WIT/wasm), makes the runtime **durable + event-sourced**, records realization as **auditable Matching**, treats **agents as principals** (not a governed copilot), and can **generate providers** rather than hand-build them — while keeping self-host = hosted parity and monetization out of scope.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Qovery concept (✅ has · ➕ goes further · ◐ designed, Qovery ships it at scale · 🔜 planned). HoBo is **design-phase**; Qovery is a mature product.

| Qovery concept | HoBo equivalent | Notes |
|---|---|---|
| **BYOC** — deploy into your AWS/GCP/Azure/Scaleway account | **Camps** on pluggable provider adapters ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ✅ same "your cloud, your data" stance · ➕ more targets, IaC-agnostic · ◐ Qovery proven at scale |
| **BYOK** — connect existing Kubernetes | provider / `component-host` adapters incl. K8s / bare-metal ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ✅ K8s is *one* host among many (wasmCloud is the default host) |
| **Qovery Engine** (Terraform/OpenTofu + Helm + K8s) | **pluggable IaC adapters** — Pulumi (primary) + Crossplane/OpenTofu ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ✅/➕ IaC is a swappable adapter *under* the control plane, not a fixed engine |
| Split control-plane / data-plane; Engine+Agent **pull outbound** | HoBo control plane + Camp data plane; **Yard-is-a-Bindle** self-host ([Plan 4](../design/control-plane.md#plan-04)) | ✅ similar separation + outbound trust · ➕ self-host = hosted parity, fully OSS |
| **Environment** = deployable unit (apps+DBs+jobs+Helm+TF, roll back together) | **Camp** + **Aspire-style wiring / manifest IR** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ same "deploy/rollback a whole environment" model |
| Service types (application/container/DB/Helm/TF/cron/lifecycle) | HoBo resource catalog — `service`/`sql`/`schedule`/`job` + OCI/Helm/TF via adapters ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ near-parity · ➕ wasm components are the default service |
| Services declared via **Console / API / Terraform / config** | **IfC** — declare resources **inline in code** + `.allow()` (one decl → IAM + wasm link + token) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ infrastructure-from-code, not config/console |
| Resource→**Terraform-module** mapping (fixed by Engine) | **Resource Definitions + Matching** (`match.Decided`) + **Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ same app → different infra per env, auditable + cost-routed |
| **Preview / ephemeral environments** (per-PR full-stack clones) | **ephemeral / preview Camps** + **sandbox lanes** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0076](../design/adr/02-identity-security.md#adr-0076)) | ✅ same thesis · ◐ Qovery ships this at scale; HoBo designs it |
| Container / Helm / **Kubernetes** runtime | **wasm/WASI-default polyglot runtime** (any language → component; capability security) ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ cloud-abstracted at the *app* model, not just ops |
| Audit of **control-plane API calls** only | **durable event-sourced runtime** — actors + workflows + sagas + replay/audit of *app state* ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ |
| **DevOps Copilot + MCP server** (agents drive infra via NL, within RBAC) | **agents as first-class principals** — Capability Manifest + MCP + brokered tokens/SVIDs ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ✅ MCP surface at parity · ➕ agents-as-principals, not a copilot over an API |
| Engine + Terraform modules (human-built provider breadth) | **generation pipeline** — AI-generated providers + implementations ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) | ➕ |
| **RBAC** (Owner/Admin/… + custom cluster/project/env-type) + SSO + audit | **org governance** — RBAC + mandatory deny-ceiling ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | ✅ maps to org governance · ◐ Qovery ships mature RBAC/SSO/SOC2; HoBo designs it |
| Least-priv cloud access (STS/short-lived tokens, scoped secrets) | `.allow()` → **least-priv IAM + wasm link + token** + secretless brokering ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[ADR-0027](../design/adr/02-identity-security.md#adr-0027)) | ✅/➕ one in-code declaration, three effects |
| CLI / API / Terraform provider / TS-JS-Go client libs | `hobo` CLI + SDK + WIT-generated clients ([Plan 7](../design/developer-experience.md#plan-07)/[ADR-0037](../design/adr/01-architecture-core.md#adr-0037)) | ✅ · ➕ `hobo import` adopts existing TF/Pulumi/FaaS estates in place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) |
| Observe (logs via Loki, metrics, K8s events) | observability + operations dashboard / status pages ([Plan 5](../design/reliability-observability-cost.md#plan-05)/[Plan 49](../design/developer-experience.md#plan-49)) | ◐ Qovery ships day-2 observability; HoBo designs it |
| **Subscription pricing** (Team/Business/Enterprise + AI seats) | monetization **out of design scope**; metering/showback is OSS FinOps ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ✗ by-design (not a gap) |

### The one-line takeaway

**Qovery proves HoBo's BYOC + preview-environment bets in production** — mature Kubernetes IDP automation that deploys into your AWS/GCP/Azure/Scaleway account, with strong RBAC, audit, and an MCP agent surface — but it abstracts **Kubernetes operations in your cloud**, not the **application** itself. HoBo's differentiation is everything beneath and around that: a **language-neutral wasm runtime**, a **durable event-sourced data plane**, **auditable Matching + the Dispatcher**, **agents-as-principals**, and an **AI generation pipeline** — with self-host = hosted parity and monetization out of scope.

## Better-together / integration posture

- **Benchmark** — preview environments and the outbound-only split-plane trust model are both bars
  HoBo must clear; Qovery is the clearest production proof that BYOC plus previews is a viable
  product.
- **Borrow** — **autonomous clusters that survive a control-plane outage** is an availability
  property HoBo's Relay/node-attach design should adopt explicitly, and **full-stack previews
  including data** is the same finding Upsun produces from a different direction.
- **Provider-target** — a Qovery-managed cluster is a plausible Camp substrate.
- **Displace** — for the BYOC-IDP buyer, honestly head-on.

## Threats and lessons

1. **Two HoBo bets are already proven by someone else.** BYOC and per-PR previews are shipping.
   HoBo's differentiation has to be below and around the ops layer — the application model, the
   recorded decision, the runtime — and saying so plainly is stronger than implying novelty.
2. **Autonomous data planes are a trust requirement, not a nicety.** A control-plane outage that
   stops customer deployments is survivable; one that stops customer *workloads* is not. HoBo's
   design should state this property explicitly.
3. **Third corpus occurrence of preview environments needing real data** (after Upsun and
   Northflank's database fork). The pattern is now unambiguous.
4. **Agent surfaces that inherit human RBAC are the current norm.** HoBo's agents-as-principals model
   is genuinely differentiated — and only if it ships with brokered, per-call scoped tokens.

## Sources

- [qovery.com/docs](https://www.qovery.com/docs) — clusters, environments, preview environments, RBAC, audit, interfaces
- [Qovery/engine](https://github.com/Qovery/engine) — the GPL-3.0 Rust engine over Terraform/OpenTofu, Helm and Kubernetes
- [qovery.com](https://www.qovery.com/) — BYOC positioning, compliance certifications, pricing tiers (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current pricing and certification scope were not re-verified in this
pass and are not asserted.
