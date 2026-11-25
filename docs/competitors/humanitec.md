---
type: Competitive Reference
title: "Humanitec — Competitor Reference"
description: "The **Platform Orchestrator** is a cloud-agnostic, multi-compute orchestration engine that powers **Internal Developer Platforms (IDPs)**. Developers describe a workload in **Score"
tags: [hobo, competitors]
competitor:
  slug: humanitec
  name: "Humanitec"
  primary_category: platform-orchestrators
  categories: [platform-orchestrators, portable-application-models]
  directness: direct
  role: "Platform Orchestrator for IDPs — the product that proved the dynamic-configuration abstraction HoBo's matching layer descends from"
  posture: [displace, benchmark]
  hobo_surface: [app-graph, environments, provider-matching, governance]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://developer.humanitec.com/platform-orchestrator/docs/introduction/overview/
    - https://developer.humanitec.com/platform-orchestrator/docs/platform-orchestrator/resources/resource-definitions/
    - https://developer.humanitec.com/platform-orchestrator/docs/deploy/score/
    - https://developer.humanitec.com/new-orchestrator/docs/what-is-the-new-orchestrator/core-concepts/
    - https://humanitec.com/products/platform-orchestrator
---

# Humanitec — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-19** (this capture predates the contract and was restructured to it, with
> its original research preserved rather than replaced). The HoBo↔Humanitec parity tracker lives in
> the [primitive mapping](#primitive-mapping) section below.
>
> **Reading the mapping tables.** Their ✅ / ➕ / 🔜 marks record HoBo's *design* status, not shipped
> behaviour: ✅ means "designed at parity", not "implemented". Sections below that make claims about
> HoBo's actual state label them **implemented**, **proof**, or **design-only** explicitly.

## What it is

The **Platform Orchestrator** is a cloud-agnostic, multi-compute orchestration engine that powers **Internal Developer Platforms (IDPs)**. Developers describe a workload in **Score** (environment-agnostic); platform engineers author **Resource Definitions** (how resources get provisioned); the Orchestrator **dynamically generates** environment-specific configuration at deploy time, enforcing standards and policy without the developer touching the details. It is *not* a portal, *not* CI/CD, *not* IaC, *not* monitoring — it is the configuration engine at the heart of an IDP. The framing: "developers describe *what*, the platform decides *how*."

Two audiences share it: developers (who write Score) and platform engineers (who write Resource Definitions). Within the common IDP "5-plane" reference architecture — Developer Control Plane (workload specs, portals), Integration & Delivery Plane (CI, registries, the Orchestrator, CD), Resource Plane (clusters, DBs, storage, DNS, VMs, serverless), Monitoring & Logging, and Security — the Orchestrator sits in plane 2 and drives plane 3.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Score** | An open, platform-agnostic, container-based workload specification Humanitec contributes to: a developer describes a workload and its resource dependencies, and the CLI can convert a Score file to deployable manifests |
| **Resource Definition** | "Defines how and when a Resource should be provisioned" — a Resource Type, a Resource Driver plus its inputs, and **Matching Criteria** saying when this definition applies |
| **Matching Criteria** | The selection rule, resolved by *specificity*: weights are summed across the criteria's parts, so "an empty Matching Criteria would score 0, one containing just an Environment ID would score 4 and one containing an Application ID and Environment Type would score 3", and the highest total wins |
| **Driver** | The execution mechanism a definition uses (terraform, template, echo, container, custom webhook) |
| **Resource Graph** | The DAG of application and infrastructure resources, executed topologically with outputs flowing between nodes |
| **Deployment Set / Delta** | An immutable snapshot of a deployment, and the mutable diff applied to it |
| **Application / Environment / Environment Type** | The lifecycle nouns, and the dimensions Matching Criteria select on |

The core mental model is **Read → Match → Create → Deploy** (RMCD), which the Orchestrator "follows …
for every Application Deployment": Read processes the Deployment Delta, "typically derived from a
Score file"; Match "identifies the Deployment context using the metadata associated with the
Deployment … the Application, the target Environment, and its Environment Type" and aligns it "with
the appropriate Resource Definitions for the given context"; Create "formulates application
configurations and initiates the Resource Definitions"; Deploy applies the result.

Concretely: read developer intent (Score) plus platform config (Resource Definitions); match the needed resource to context (`env_type`, `app`, `env`, `resource_class`, `resource_id`); select the best Resource Definition by specificity score; build a Resource Graph (DAG); execute Drivers; and record an immutable Deployment Set plus a Delta. The single source of truth is Score (*what*) combined with Resource Definitions (*how*). The current generation is compute-agnostic — "any compute, any cloud," meaning VMs, Kubernetes, serverless, or anything Terraform/OpenTofu can manage — while retaining the projects/environments/resource-graph abstractions.

## Feature surface

### Score — the workload spec (developer intent)

Score is an open, platform-agnostic workload spec (CNCF Sandbox, created by Humanitec). Developers write `score.yaml` once, specifying containers, service ports, and abstract resource dependencies; the same file deploys to any environment unchanged.

```yaml
apiVersion: score.dev/v1b1
metadata:
  name: my-app
containers:
  my-container:
    image: my-app:latest
    variables:
      DATABASE_URL: "postgres://${resources.db.username}:${resources.db.password}@${resources.db.host}:${resources.db.port}/${resources.db.name}"
    resources:
      limits: { cpu: "0.5", memory: "512Mi" }
      requests: { cpu: "0.1", memory: "128Mi" }
service:
  ports:
    http: { port: 8080, targetPort: 3001 }
resources:
  db:    { type: postgres, class: standard, id: shared.primary }
  dns:   { type: dns }
  s3:    { type: s3, class: private, id: data-bucket }
```

A companion `humanitec.score.yaml` carries Humanitec-specific extensions (workload profile, annotations, overrides).

### Resource Definitions and Matching

A **Resource Definition** is the platform-engineer-authored rule for an abstract `type` (plus optional `class`): which **driver** runs, what **inputs** it gets, and the **matching criteria** that select this definition.

```yaml
apiVersion: entity.humanitec.io/v1b1
kind: Definition
metadata: { id: postgres-prod-ha }
entity:
  name: postgres-prod-ha
  type: postgres
  driver_type: humanitec/terraform
  driver_inputs:
    values:
      tf_code: |
        resource "aws_db_instance" "main" {
          identifier     = "${context.app.id}-${context.env.id}-db"
          engine         = "postgres"
          instance_class = "db.r6g.large"
          multi_az       = true
        }
        output "host" { value = aws_db_instance.main.address }
  criteria:
    - env_type: production
      resource_class: high-availability
```

For a needed resource in context `{env_type, app_id, env_id, resource_type, resource_class, resource_id}`, the Orchestrator gathers all definitions of that type, evaluates each definition's criteria, **scores by specificity**, and selects the highest. All listed fields in a criterion must match; the most specific wins; ties break to the next-most-specific.

```yaml
- {}                                                  # score 0 (catch-all)
- env_type: production                                # score 1
- env_type: production, resource_class: ha            # score 2
- env_type: production, app_id: critical, resource_class: ha  # score 3 (wins)
```

### Resource Graph (DAG)

Each deployment produces a DAG whose nodes are resource instances and whose edges are dependencies:

- **Implicit resources** (auto-provisioned scaffolding): `workload`, `base-env`, `k8s-cluster`, `k8s-namespace`.
- **Dependent resources**: those Score requests.
- **Co-provisioned resources**: extra resources a single Resource Definition provisions together (e.g. an S3 bucket plus its IAM policy), including the edges between them.

Resources are identified by the triple **`(type, class, id)`**; shared resources use `id: shared.<name>` and are provisioned once, then reused across workloads. References create edges and flow outputs — `${resources.postgres.standard#shared.primary.outputs.host}`. The graph is topologically ordered; independent nodes provision in parallel; retries are idempotent (≈2). Placeholders span context (`${context.app.id}`, `${context.env.id}`, `${context.env.type}`, `${context.res.id}`, `${context.res.class}`, `${context.res.type}`), resource outputs (`${resources.<type>.<class>#<id>.outputs.<name>}`), and implicit values (`${implicit.k8s.namespace}`).

Resource lifecycle distinguishes an **active resource** (a real provisioned object — RDS instance, bucket, namespace — whose driver keeps state across runs), a **shared resource** (`shared.<name>`, one active resource deduped by `(type,class,id)` and reused across workloads in an environment), and **implicit resources** (the auto scaffolding above).

### Drivers, Resource Packs, and Workload Profiles

A **Driver** provisions a resource given a Resource Definition's inputs plus context, returning outputs and optionally Kubernetes manifests. Drivers are the core extension point and the mechanism that keeps Humanitec IaC-agnostic — Terraform, Pulumi, CloudFormation, or anything HTTP-callable.

| Driver | `driver_type` | What it does |
|---|---|---|
| **Terraform** | `humanitec/terraform` | Runs Terraform/OpenTofu (inline `tf_code` or Git module); manages state; any TF provider. GA. |
| **Template** | `humanitec/template` | Renders Go templates → Kubernetes manifests (Namespace, Service, Ingress, CRDs, quotas…). |
| **Echo** | `humanitec/echo` | Passes inputs through as outputs unchanged — for **externally-managed** resources Humanitec reads but does not provision. |
| **Container** | `humanitec/container` | Runs a K8s Job for complex/custom provisioning (Pulumi, CloudFormation, scripts); a sidecar `outputs-fetcher` reads the outputs JSON. |
| **Custom (webhook)** | `custom/<name>` | Calls a self-hosted HTTP service (signed JWT payload); returns outputs JSON plus optional manifests. Any tech stack. |

The driver interface is conceptually a PUT/DELETE contract — input (context + driver inputs + old state) in, outputs (and optional manifests) out:

```json
{ "context": {"app_id":"my-app","env_id":"prod","env_type":"production",
              "res_id":"shared.primary","res_type":"postgres","res_class":"ha"},
  "driver_inputs": {"tf_code":"...","instance_class":"db.r6g.large"},
  "old_state": { } }
```

```json
{ "outputs": {"host":"...","port":5432,"username":"...","password":"...","connection_string":"..."},
  "manifests": [ { "apiVersion":"v1","kind":"Secret", "...":"..." } ] }
```

Custom drivers register with type, JSON input-schema, URL, and supported account credentials. Humanitec publishes an open-source driver library (AWS/GCP/Azure) plus community contributions. **Resource Packs** are pre-built collections of Resource Definitions for common use cases (AWS, GCP, Azure, in-cluster), typically using the Terraform or Template driver, imported into an org and customized via matching criteria (marketplace at humanitec.com/marketplace). **Workload Profiles** template *how a workload is realized* — Kubernetes Deployment vs serverless vs batch job; the built-in `container` profile is the default, custom profiles come from a spec plus Helm chart, and the selected profile shapes the produced manifests (enabling Dapr services, gRPC servers, batch jobs, etc.).

### Applications, Environments, and lifecycle

An **Application** is a logical grouping of workloads plus shared resources (org-level). An **Environment** is an instance of an app with its own config, carrying an **Environment Type** (`development`/`staging`/`production`/custom) that is the primary matching dimension. A new environment can be **cloned** from one with a prior successful deployment (creating a draft Delta). **Ephemeral / dynamic environments** are per-PR/feature, created and torn down via CI; platform engineers map cheap variants (in-cluster DB, serverless) to ephemeral environments through matching.

Deployment state is captured as two artifacts. A **Deployment Set** is an immutable, complete configuration snapshot (`modules` + `shared`) for an app at a point in time. A **Deployment Delta** is a mutable draft diff (create/update/delete of modules and resources) applied to a Set, combinable and reviewable before committing. The flow: Score → generate **Delta** → review/approve → apply to create a new **Set** → execute drivers → record an immutable Deployment (the audit trail). **Rollback** re-applies a previous Deployment's Set and graph (stateful resources keep state); **incremental deployments** update only changed resources.

The CLI is `humctl`:

```bash
humctl score deploy -f score.yaml --org O --app A --env prod --image my-app:v1 --message "..." --wait
humctl deploy delta <DELTA_ID> <ENV> --app A
humctl create env <ENV> --type production --from <SRC_ENV>   # clone
humctl rollback <ENV> --app A
humctl get deployments --app A --env prod
humctl describe environment --app A --env prod               # resource graph
humctl apply -f resource-definition.yaml
```

The REST API base is `https://api.humanitec.dev` (Bearer token), with endpoints for orgs/apps/envs/deploys/definitions/logs. A Terraform provider (`humanitec/humanitec`) manages Humanitec resources as IaC.

### Portal and developer self-service

The Portal is a web UI atop the Orchestrator: self-service environments and deployments, app status, resource-graph visualization, and drift detection; platform engineers do resource management and setup here. It offers **golden paths / paved roads** (platform rules developers follow declaratively via Score), service catalogs, dashboards, self-service templates/scaffolding, **scorecards** (health/compliance, DORA metrics), RBAC, and automated docs/audit. The Portal is **optional and modular** — teams can use the API/CLI or other portals (Backstage, Port.io) instead. Humanitec frames the split cleanly: the Orchestrator is the engine; the portal is one surface.

### Connectivity — Agent and Operator

The **Humanitec Agent** is a lightweight proxy inside the customer's private network so the **SaaS** Orchestrator can deploy into **private/air-gapped** clusters **without inbound access**. It opens an **outbound TCP 443** reverse tunnel to Humanitec — no open ports or exposed endpoints — TLS-encrypted and authenticated, with credentials staying in-network; the Orchestrator never connects directly to private clusters, proxying everything through the Agent. Installed as a K8s agent, one Agent can manage multiple clusters (private K8s, multi-region/multi-cloud, regulated/air-gapped), and it also enables a GitOps mode where the Agent pulls runtime data.

The **Humanitec Operator** is separate from the Agent: a K8s operator on each cluster (public or private) that manages CRDs and provisions **Secrets** from secret stores. It is a Helm-installed controller-manager that acts on resource changes.

### CI/CD, Pipelines, and GitOps

Humanitec works with **any** CI (GitHub Actions, GitLab, Bitbucket, CircleCI, Jenkins, Codefresh). The pattern: CI builds an image → notifies the Orchestrator of the new artifact → the Orchestrator deploys (via `humctl score deploy --image <ver>` or a webhook, using a service-user token). **Humanitec Pipelines** add multi-step deployment workflows triggered by a **Deployment Request** (new artifacts matching criteria) or the **API**. **Deployment rules** are if-then (e.g. "new image from dev HEAD → deploy dev-testing") with flexible image matching/exclusion; jobs run in parallel with `needs` for ordering, capped at ~10 concurrent runs, with custom `concurrency` locks; they can integrate policy checks, sign-offs, and Slack/Teams notifications. In **GitOps mode**, the Orchestrator writes the Resource Graph as K8s Custom Resources to a Git repo/branch and ArgoCD/Flux sync to clusters — standalone or hybrid.

Deployment targets are Kubernetes-centric (EKS/GKE/AKS/on-prem/private). Cloud resources come via the **Terraform driver** (any TF provider), **Template driver** (K8s), and **Container driver** (Pulumi/CFN/custom). The "any compute" direction extends to VMs and serverless, but K8s remains primary and native serverless (Cloud Run/Lambda as primary compute) is limited.

### Governance, secrets, and observability

**RBAC** operates at **Organization / Application / Environment-Type** levels, least-privilege by default, with roles like admin/developer/ops/delivery-manager/approver/viewer. **Approvals and sign-offs** run via Pipelines and webhooks (e.g. notify Slack pre-prod, delivery manager confirms prod), and policy checks run automatically pre-deploy — standardization by design (devs declare *what*, the platform enforces *how*).

**Secrets** are a resource type whose outputs inject into containers at runtime, never logged or persisted in manifests/Git; stores include **Vault** (KV v2, dynamic creds), **Azure Key Vault**, **Infisical**, and **native K8s**, with shared values/secrets scoped to app/environment with overrides.

For observability and audit, a deployment-status tab shows the active deployment plus workloads and shared resources; resource-status health comes via the Operator; plan-only and historical resource graphs are available. **Drift detection** (via the TF provider) compares desired (graph) against actual and alerts on config drift. Scorecards and DORA metrics ship in the Portal, and external monitoring (Prometheus/Datadog) integrates through resource definitions — Humanitec is not a full observability platform. The **audit log** records every API change on every entity (who/when/action), with min **365-day** immutable retention, but **no request bodies and no IPs**, and up to a ~5-min delay.

### Extensibility and API

Drivers are the core extension (HTTP PUT/DELETE implementing the driver interface; any stack; embedding TF/Pulumi/CFN/custom). Resource Packs bundle definitions; the open-source driver library seeds them. The REST API covers all entities; **webhooks** fire on env create/delete and deploy start/complete with customizable payloads and variable substitution; the Terraform provider manages Humanitec as IaC; and **MCP** support lets AI agents (Claude, ChatGPT) drive the Orchestrator directly.

### Editions and pricing

- **SaaS (cloud-hosted):** fully managed, multi-tenant; uses the Agent for private-cluster access.
- **Self-hosted:** the entire Orchestrator on customer infra — data sovereignty, **air-gapped** support, regulated industries (banking/insurance/gov/defense), GovCloud/sovereign clouds.
- **Free / community:** a free trial (no card); a free community version is mentioned (limits not fully public).
- **Pricing:** not publicly disclosed — demo/contact required, an adoption and comparison friction point.

## Architecture

- **Control plane** — the Orchestrator: SaaS, self-hosted, or air-gapped. Holds Resource
  Definitions, Deployment Sets/Deltas, the Resource Graph, RBAC and audit.
- **Data plane** — the customer's clusters, databases, DNS, VMs and serverless targets. The current
  generation is compute-agnostic: "any compute, any cloud", meaning anything Terraform/OpenTofu can
  manage, not only Kubernetes.
- **Connectivity** — the **Agent** provides an outbound-only reverse tunnel into private networks;
  the **Operator** handles secret provisioning inside the cluster so credentials need not transit
  the control plane.
- **Execution model** — RMCD per deployment: match definitions by specificity, build the Resource
  Graph, execute Drivers topologically, record an immutable Deployment Set plus a Delta.
- **State authority** — Deployment Sets (immutable) and Deltas (diffs) in the Orchestrator, plus
  whatever state the Drivers' own IaC keeps. This is the closest thing in the corpus to an
  event-shaped authority, but it is a snapshot-and-diff model rather than an append-only log: there
  is no replay of *decisions*, only a record of *results*.
- **Portability boundary** — genuinely broad, because Drivers delegate to IaC. The boundary is that
  portability is a property of the Resource Definitions a platform team wrote, not of the workload
  spec: Score is portable, the realization is bespoke per organization.

## How it competes with HoBo

Humanitec is the **direct architectural ancestor** of HoBo's matching layer, and remains its most
direct competitor on that surface. [`lineage.md`](../design/lineage.md) records it as a
pillar-adjacent borrow-source, and this capture does not soften that: the Resource
Definitions + Matching + Drivers + Sets/Deltas engine is the shape HoBo adopted.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `app-graph` | The Resource Graph is a real, queryable app+infra DAG with output flow |
| `provider-matching` | **The sharpest contest.** Specificity-scored Matching Criteria are HoBo's matching layer, shipped and enterprise-proven |
| `environments` | Applications / Environments / Environment Types, with cloning and ephemeral environments |
| `governance` | RBAC, approval workflows, drift detection, immutable audit |
| `extensibility` | Drivers, Resource Packs, an open Score spec, a Terraform provider |

The difference is not the abstraction — HoBo agrees with the abstraction — but what the platform can
*prove* about its own decisions, what it can run on, and who owns the code. Those three, and not
"dynamic configuration", are HoBo's argument here.

## Where Humanitec is stronger

> Shipped, evidenced capability only.

1. **Dynamic configuration management** — Score (intent) + Resource Definitions (rules) + **Matching** → environment-specific config generated at deploy time. The cleanest dev-vs-platform separation in the market.
2. **Resource Graph** — a real, queryable DAG of app + infra with co-provisioning and output flow; topologically executed.
3. **Driver model** — IaC-agnostic execution (terraform/template/echo/container/custom-webhook); extend by HTTP.
4. **Deployment Sets + Deltas** — immutable snapshots plus mutable diffs → clean promote/rollback/preview and incremental deploys.
5. **Governance** — RBAC (org/app/env-type), approval workflows, drift detection, immutable audit.
6. **Enterprise reach** — SaaS + self-hosted + air-gapped; the Agent for private networks; regulated/sovereign markets.
7. **Ecosystem** — Resource Packs, the open Score spec, a Terraform provider, open-source drivers, and MCP for AI agents.

### Positioning against adjacent tools (Humanitec's own framing — vendor claims, recorded as such)

- **vs Backstage** — complementary, not competitive. Backstage is a developer **portal** (catalog/scaffolding, OSS framework); Humanitec is the **backend orchestrator** (config generation, provisioning). "Deploy Humanitec first, layer Backstage on top"; Humanitec argues Backstage is framework-heavy DIY.
- **vs Terraform / Pulumi** — Humanitec is the **orchestration layer above** IaC: it orchestrates and standardizes TF execution via drivers (declarative, policy-driven) rather than replacing it.
- **vs Crossplane** — Crossplane is a K8s-native control plane (CRDs); Humanitec is broader app+infra orchestration that does not require modeling everything as K8s CRDs.
- **vs ArgoCD / Flux** — GitOps operators sync Git→cluster; Humanitec **generates** what to sync (and adds multi-stage workflows, approvals, policy), then can hand off to Argo/Flux.
- **vs Qovery / Northflank / Nitric** — those are simpler PaaS/serverless-first; Humanitec is enterprise-grade orchestration with deep policy/governance and a single app+infra graph (more upfront config, more control).

## Adversarial critique

> Lock-in, coupling, operational cost, and weaknesses — several of which are also HoBo's openings.

1. **K8s-centric; weak serverless** — no first-class Cloud Run/Lambda compute → HoBo leads with **wasm components + OCI fallback**, polyglot.
2. **Steep learning curve** — many interlocking concepts (Resource Types/Definitions/Drivers/Runners/Manifests), and docs lag features → HoBo's **IfC-default** authoring plus mapping-as-sugar keeps the simple path simple.
3. **Opaque pricing + proprietary core** → HoBo ships an **OSS core**, self-host = hosted.
4. **Opaque matching selection** — no first-class "why this infra" audit → HoBo records **`match.Decided`** events, replayable.
5. **No event-sourcing/replay/time-travel** → HoBo's core is event-sourced (audit + DR + run inspector).
6. **Human-authored Resource Definitions/Packs** → HoBo's **generation pipeline** can AI-generate definitions and packs, gated by conformance.
7. **Not a full observability platform** → HoBo bundles run inspector/traces/replay.
8. **Vendor lock-in (Manifests)**, though Score is open → HoBo ports are **WIT interfaces** (standards-based); Score is importable for interop.

> Net: Humanitec proves the orchestrator abstraction and governance; HoBo adopts that engine and adds a polyglot wasm runtime, event-sourced auditability, AI-native generation, and OSS openness. Because Humanitec is mature, enterprise-grade, and now explicitly AI-first, HoBo cannot win on "AI-native" alone — it must combine Humanitec's best engine (Resource Definitions + Matching, drivers, sets/deltas, governance) with what Humanitec lacks: a wasm-first polyglot runtime, event-sourced replay/time-travel plus auditable matching decisions, AI-generated definitions/implementations, IfC-default simplicity, and an OSS core.

## Primitive mapping

<a id="hobo-mapping"></a>

> For every Humanitec feature, the HoBo equivalent and the design doc that owns it. ✅ = designed at parity · ➕ = HoBo goes further · 🔜 = planned/roadmap. HoBo design lives in [`../../design/`](../design/index.md).

### Core engine

| Humanitec | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Dynamic configuration management (Score + Resource Definitions + Matching) | **Resource Definitions + Matching** as the Planner's platform-rules layer; mapping = sugar over default definitions | ✅➕ | [25](../design/platform-engineering.md#plan-25) |
| Resource Definition | HoBo Resource Definition (**WIT-interface-typed**, auto-generatable) | ➕ | [25](../design/platform-engineering.md#plan-25) |
| Matching Criteria (specificity scoring) | Same model; the winning definition + score recorded as a **`match.Decided`** event (auditable "why this infra") | ➕ | [25](../design/platform-engineering.md#plan-25), [11](../design/data-plane.md#plan-11) |
| Resource classes (`standard`/`ha`/…) | Resource `class` as a matching dimension | ✅ | [21](../design/authoring-resources-wiring.md#plan-21) |
| Resource Graph (DAG, co-provision, outputs) | DeploymentPlan DAG + ResourceActors + manifest links | ✅ | [03](../design/control-plane.md#plan-04), [04](../design/control-plane.md#plan-04) |
| Drivers (terraform/template/echo/container/custom-webhook) | **Driver taxonomy** generalizing IaC adapters (incl. echo/BYO + webhook) | ✅ | [27](../design/platform-engineering.md#plan-25), [03](../design/control-plane.md#plan-04) |
| Deployment Sets (immutable) + Deltas (mutable) | **Set = manifest IR**, **Delta = event-sourced diff**; promote/rollback/incremental | ✅➕ | [26](../design/platform-engineering.md#plan-25), [22](../design/authoring-resources-wiring.md#plan-21) |
| Placeholders (`${resources..outputs}`, `${context.*}`) | Aspire-style lazy refs aligned to this syntax | ✅ | [22](../design/authoring-resources-wiring.md#plan-21) |
| Score workload spec | HoBo IfC resources + WIT ports; **Score importable** (interop) | ✅➕ | [02](../design/sdk-api.md#plan-02), [21](../design/authoring-resources-wiring.md#plan-21) |
| Shared / active / implicit resources | Shared resources + ResourceActors + implicit scaffolding | ✅ | [04](../design/control-plane.md#plan-04) |

### Environments & lifecycle

| Humanitec | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Applications / Environments / Environment Types | Bindle / **Camp** with **environment type** (matching dimension) | ✅ | [26](../design/platform-engineering.md#plan-25) |
| Env cloning | Camp `clone-from` | ✅ | [26](../design/platform-engineering.md#plan-25) |
| Ephemeral / dynamic (per-PR) environments | Ephemeral/preview Camps (auto-TTL) | ✅ | [26](../design/platform-engineering.md#plan-25) |
| Workload Profiles | **Workload Profiles** (wasm-component/container/serverless/VM) | ✅ | [27](../design/platform-engineering.md#plan-25) |
| Rollback / incremental deploys | Event-sourced rollback + incremental reconcile | ✅ | [26](../design/platform-engineering.md#plan-25), [04](../design/control-plane.md#plan-04) |

### Platform & operations

| Humanitec | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Portal (golden paths, catalogs, scorecards) | HoBo dashboard + resource-graph/matching/delta/pipeline views | ✅ | [07](../design/developer-experience.md#plan-07) |
| Agent (private-network reverse tunnel) | **HoBo Relay** (outbound-only; Executors run behind it) | ✅ | [28](../design/platform-engineering.md#plan-25), [12](../design/security-networking.md#plan-12), [13](../design/security-networking.md#plan-12) |
| Operator (secret provisioning) | Provider `secrets` port + brokered tokens | ✅ | [06](../design/ai-native-agent-auth.md#plan-06), [12](../design/security-networking.md#plan-12) |
| Pipelines (triggers + approval gates) | **Pipelines** atop sagas + policy gates | ✅ | [28](../design/platform-engineering.md#plan-25), [05](../design/reliability-observability-cost.md#plan-05) |
| GitOps mode (write CRs to Git) | **GitOps publisher** target | ✅ | [28](../design/platform-engineering.md#plan-25), [22](../design/authoring-resources-wiring.md#plan-21) |
| Resource Packs | **Resource Packs** in the Registry (auto-generatable) | ➕ | [27](../design/platform-engineering.md#plan-25), [06](../design/ai-native-agent-auth.md#plan-06) |
| RBAC + approvals | ABAC + policy gates | ✅ | [12](../design/security-networking.md#plan-12), [06](../design/ai-native-agent-auth.md#plan-06) |
| Audit logs (365d, immutable) | Event log **is** the audit log (replayable) | ➕ | [11](../design/data-plane.md#plan-11), [14](../design/reliability-observability-cost.md#plan-05) |
| Drift detection | Drift loop (heal/propose/ignore) | ✅ | [05](../design/reliability-observability-cost.md#plan-05) |
| CI/CD integration | CLI/MCP + Pipelines + artifact triggers | ✅ | [15](../design/developer-experience.md#plan-07), [28](../design/platform-engineering.md#plan-25) |
| MCP (AI agents drive it) | `@hobo/mcp` (agents as first-class principals) | ➕ | [06](../design/ai-native-agent-auth.md#plan-06) |
| Self-hosted + air-gapped | Self-host = hosted (the Yard is a Bindle) + Agent | ✅ | [04](../design/control-plane.md#plan-04) |
| IDP "5-plane" framing | HoBo = Integration & Delivery plane orchestrator | ✅ | [00](../design/vision.md#plan-00), [17](../design/vision.md#plan-17) |

## Where HoBo is stronger or intentionally different

State labels: **implemented** = shipped in `packages/`; **proof** = draft/proof material;
**design-only** = design intent. See the [live provider matrix](../design/live-provider-matrix.md)
for HoBo's honest coverage caveats.

| Capability | State | HoBo doc |
|---|---|---|
| **Auditable matching** (`match.Decided` events — "why this infra", replayable) | implemented | [25](../design/platform-engineering.md#plan-25), [11](../design/data-plane.md#plan-11) |
| **WASM-first polyglot runtime** (not K8s-centric) | mixed — wasmCloud host adopted, provider breadth partial | [20](../design/wasm-runtime-wit.md#plan-20) |
| **Event-sourced replay/time-travel + DR-as-replay** | implemented (ADR-0135) | [11](../design/data-plane.md#plan-11), [05](../design/reliability-observability-cost.md#plan-05) |
| **AI-generated Resource Definitions, Packs & implementations** (not human-only) | proof | [23](../design/generated-stack.md#plan-23), [06](../design/ai-native-agent-auth.md#plan-06) |
| **IfC-default simplicity** + mapping-as-sugar (lower learning curve) | implemented | [02](../design/sdk-api.md#plan-02), [25](../design/platform-engineering.md#plan-25) |
| **OSS core + WIT-standard ports** (less lock-in) | implemented | [17](../design/vision.md#plan-17), [24](../design/wasm-runtime-wit.md#plan-20) |

### Open parity items (iteration hooks)

- Resource Definition authoring surface: TS (typed) vs YAML (Humanitec-parity) vs both.
- Whether `echo`/BYO resources participate in drift/reconcile or are read-only.
- Agent transport + multi-cluster routing details.
- Matching scoring exactly mirroring Humanitec vs a HoBo refinement (explicit priorities).

## Better-together / integration posture

- **Borrow** — already done, and worth stating plainly: Resource Definitions + Matching, the Driver
  taxonomy, Deployment Sets/Deltas, and the Agent's outbound-only tunnel are all recorded as
  borrow-sources in [`lineage.md`](../design/lineage.md). Humanitec is the single largest influence
  on HoBo's platform-engineering layer.
- **Displace** — for the buyer who wants an orchestrator, this is the incumbent to unseat, on
  auditability, runtime breadth and openness rather than on the core abstraction.
- **Standard** — **Score** is an open specification Humanitec contributes to, and treating it as an
  interop standard (importable into HoBo) is strictly better than competing with it.
- **Benchmark** — governance depth, air-gapped operation, and the Resource Pack ecosystem.
- Not an adopt, provider, or render target.

## Threats and lessons

1. **The engine is proven; the argument has to be elsewhere.** Matching-by-specificity works at
   enterprise scale. HoBo cannot claim the idea — it can claim that the decision is *recorded and
   replayable* (`match.Decided`), that the runtime is not Kubernetes-shaped, and that the core is
   open. Positioning that leads with "dynamic configuration" concedes the ground.
2. **Score is the interop lever.** An open workload spec with an existing user base is the cheapest
   possible on-ramp into HoBo. Supporting Score import is worth more than a proprietary equivalent.
3. **Specificity scoring is subtly opaque.** Summed weights decide which definition wins, and
   nothing explains the outcome to the user. That is precisely the gap `match.Decided` fills, and it
   is a concrete, demonstrable differentiator rather than a philosophical one.
4. **Snapshot-and-diff is not replay.** Deployment Sets and Deltas get close enough that the
   distinction must be made carefully and honestly: Humanitec records results immutably; HoBo
   records *decisions* append-only. Overstating this difference would be as damaging as ignoring it.
5. **Enterprise reach is a moat.** SaaS + self-hosted + air-gapped, with an Agent for private
   networks, addresses regulated and sovereign markets HoBo's design contemplates but has not
   proven.

## Sources

- [Platform Orchestrator overview](https://developer.humanitec.com/platform-orchestrator/docs/introduction/overview/) — product boundary and positioning
- [Resource Definitions](https://developer.humanitec.com/platform-orchestrator/docs/platform-orchestrator/resources/resource-definitions/) — definition structure, Resource Types, Drivers, Matching Criteria and specificity weights
- [Core concepts](https://developer.humanitec.com/new-orchestrator/docs/what-is-the-new-orchestrator/core-concepts/) — the Read → Match → Create → Deploy sequence
- [Score](https://developer.humanitec.com/platform-orchestrator/docs/deploy/score/) and [score.dev](https://docs.score.dev) — the open workload specification
- [Platform Orchestrator product page](https://humanitec.com/products/platform-orchestrator) and [infrastructure orchestration](https://humanitec.com/infrastructure-orchestration) — vendor positioning, recorded as claims

Pricing specifics, current edition boundaries, and the operational maturity of the AI/MCP surface
were not re-verified in this pass and are not asserted.
