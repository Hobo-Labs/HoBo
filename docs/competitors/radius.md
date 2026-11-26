---
type: Competitive Reference
title: "Radius — competitor reference"
description: "Radius is an **open-source, cloud-native application platform** (Apache-2.0, CNCF Sandbox, incubated by Microsoft Azure Incubations) — an **Application/Environment app model** with **Recipes** (env"
tags: [hobo, competitors]
competitor:
  slug: radius
  name: "Radius"
  aliases: ["radapp"]
  primary_category: portable-application-models
  categories: [portable-application-models, platform-orchestrators]
  directness: overlapping
  role: "CNCF cloud-native application platform (app graph, Recipes, connections) — borrow-source for recipes and app model"
  posture: [borrow]
  hobo_surface: [app-graph, typed-contracts, environments]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.radapp.io/concepts/
    - https://github.com/radius-project/radius
---

# Radius — competitor reference

> A faithful capture of **Radius** (radapp.io) for HoBo competitive analysis. Radius is an **adjacent borrow-source, not a head-on competitor**: HoBo already borrows Radius's **Recipes / equivalence-classes** and its **dev-vs-platform separation** ([vision.md:72](../design/vision.md)). Radius is a **cloud-native application platform** — a first-class **Application** graph, an **Environment** landing-zone model, and **Recipes** (environment-specific, Terraform/Bicep-backed infra provisioning) that give developers a portable app definition while operators own the infrastructure. Sources: [radapp.io](https://radapp.io/) · [docs.radapp.io](https://docs.radapp.io/concepts/) · [Recipes docs](https://docs.radapp.io/guides/recipes/) · [App Graph blog](https://blog.radapp.io/posts/2024/02/27/understand-your-entire-application-with-the-radius-application-graph/) · [github.com/radius-project/radius](https://github.com/radius-project/radius) · [Azure Incubations launch](https://azure.microsoft.com/en-us/blog/the-microsoft-azure-incubations-team-launches-radius-a-new-open-application-platform-for-the-cloud/) · [CNCF Sandbox acceptance](https://blog.radapp.io/posts/2024/04/16/radius-accepted-as-cloud-native-compute-foundation-cncf-sandbox-project/). License **Apache-2.0**; **CNCF Sandbox** project; incubated by the **Microsoft Azure Incubations** team. Researched July 2026; API/CLI/recipe shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Radius is *"an open-source, cloud-native, application platform that enables developers and the operators that support them to define, deploy, and collaborate on cloud-native applications across public clouds and private infrastructure"* — launched by the **Microsoft Azure Incubations** team in October 2023 and accepted as a **CNCF Sandbox** project in April 2024. Its tagline is *"Cloud-native applications are more than just Kubernetes."* The core primitives are an **Application graph** and **Recipes**, which work together so a single portable app definition deploys across dev, on-prem, and public clouds with one consistent toolchain.

The mental model is an explicit **developer/operator separation of concerns**: *"Developers define Applications and their dependencies, not the underlying infrastructure. Operators define Environments with platform configuration, infrastructure, and policies that enforce their organization's requirements."* Developers author an **Application** in **Bicep** (`app.bicep`) — a first-class resource that groups containers, datastores, and their **connections**. Platform engineers define **Resource Types** (*"the interface, or contract, between developers and the platform"*) and **Recipes** (*"the resource deployment implementation"* — Terraform or Bicep templates), then bind them in **Environments** (*"where Resource Types, Recipes, and cloud providers come together"*). This is exactly the split HoBo borrows: HoBo's provider-agnostic `bindle()` vs. provider-specific `camp()`/`yard()` scopes, and its **Resource Definitions + Matching**, are the same dev-vs-platform seam applied to a wasm + event-sourced substrate ([vision.md:72](../design/vision.md), [Plan 25](../design/platform-engineering.md#plan-25)).

The developer never picks infra: they declare an abstract resource (`db 'Applications.Datastores/redisCaches'`) and, per **Environment**, the operator's registered **Recipe** decides *how* it's realized — an in-cluster Redis for `dev`, a managed cache for `prod` — with no app-code change. Radius's control plane (the **Universal Control Plane** + deployment engine) currently **runs on Kubernetes**; apps deploy as Kubernetes workloads alongside Azure/AWS cloud resources, and **Dapr** is built in for microservice building blocks.

| Dimension | Radius |
|---|---|
| Authoring | **Bicep** app definitions (`app.bicep`); Recipes authored in **Bicep or Terraform** (IaC files, not general-purpose code) |
| App model | first-class **Application** resource grouping containers + resources; **Resource Types** = the developer↔platform contract abstraction |
| Resources | containers, datastores (Redis/Mongo/SQL), gateways, secrets, volumes, **Dapr** building blocks; **portable** + cloud (Azure/AWS) resources; **user-defined Resource Types** (custom schemas) |
| Recipes | environment-scoped IaC templates (**Terraform/Bicep**) that provision a Resource Type's backing infra; **swappable per environment** (dev/canary/prod); receive a `context`, return `{ values, secrets, resources }` |
| Connections | `connections: { name: { source: res.id } }` → Radius **auto-injects env vars** (`CONNECTION_<NAME>_<FIELD>`) + wires access |
| App Graph | auto-derived graph of resources + connections + environments; *"always up to date without requiring additional effort from developers"*; `rad app graph`, Dashboard, HTTP API |
| Platform / runtime | **control plane runs on Kubernetes** (UCP + deployment engine); apps deploy as **K8s workloads** (+ Azure/AWS resources); no bespoke app runtime |
| Local dev | `rad init` scaffolds an environment + sample `app.bicep`; `rad run` deploys to a local K8s cluster + port-forwards; **local-dev Recipes** |
| Clouds | **Azure, AWS, any Kubernetes**, private/on-prem — *"multi-cloud from the start"* |
| CLI / UI | `rad` (init/run/deploy/app graph/recipe/env/resource/group/install/bicep publish); web **Dashboard** |
| AI | **Resource Types** pitched for AI apps (swap model providers without rewrites); no agent-identity / generation-pipeline story |
| License / status | **Apache-2.0**; **CNCF Sandbox** (Apr 2024); incubated by **Microsoft Azure Incubations** (Oct 2023); written in **Go** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Application** | The first-class deployable unit grouping resources and their connections |
| **Resource Type** | The developer-facing abstraction (a database, a cache) — the contract between developer and operator |
| **Recipe** | The operator-owned, environment-bound realization of a Resource Type, backed by Terraform or Bicep |
| **Environment** | The landing zone binding recipes and providers for one lifecycle stage |
| **Connection** | A declared dependency between resources, auto-injecting configuration and expressing reachability |
| **Application Graph** | The automatically derived graph of resources and connections, exposed via CLI, API and Dashboard |

The mental model is **one abstraction, many environment-bound realizations**: a developer names a
Resource Type; the operator has bound that type to a Recipe per Environment; deploying the same
application to a different Environment produces different infrastructure with no application change.
That idea — swap by binding, not by editing the app — is the thing HoBo borrows.

## How it competes with HoBo

Radius is a **borrow-source before it is a competitor**, and this capture keeps that framing rather
than inflating the overlap. The contested surfaces:

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `app-graph` | The Application Graph is shipped, live, and visible in a Dashboard — ahead of HoBo's equivalent |
| `typed-contracts` | Resource Types are the developer/operator contract seam |
| `environments` | Environments bind recipes and providers per stage |
| `provider-matching` | **The sharpest contest, and the clearest divergence.** Radius binds one recipe per type per environment; HoBo scores candidates and records the decision |
| `wiring` | Connections inject configuration and express reachability |

HoBo agrees with Radius's model and diverges on substrate (wasm and an event log versus Kubernetes),
authoring (in-code IfC versus Bicep files), and — most importantly — on whether the realization is a
static binding or a scored, recorded decision.

## Feature surface

### The application model — Applications, Resource Types, Environments

- **Application.** *"Developers first define an Application resource, then add resources to that Application such as containers and databases."* The Application is a first-class resource that groups related infrastructure; every deploy generates its **App Graph** (below). A minimal `app.bicep`:
  ```bicep
  extension radius

  @description('The Radius Application ID. Injected automatically by the rad CLI.')
  param application string

  resource demo 'Applications.Core/containers@2023-10-01-preview' = {
    name: 'demo'
    properties: {
      application: application
      container: {
        image: 'ghcr.io/radius-project/samples/demo:latest'
        ports: { web: { containerPort: 3000 } }
      }
    }
  }
  ```
- **Resource Types.** *"Resource Types define the abstraction for a resource that will exist in the real world when deployed"* — *"the interface, or contract, between developers and the platform."* Radius ships core/portable types (`Applications.Core/containers`, `Applications.Datastores/redisCaches`, …) and, since 2025, **user-defined Resource Types**: platform engineers *"define the schema definition"* for a custom type (e.g. `aiModels`) and *"then implement Recipes using Bicep or Terraform that deploy the infrastructure,"* so developers *"reference the required resources in their application via simple, high-level abstractions"* while implementation stays with the platform team.
- **Environments.** *"An Environment defines where applications are deployed; i.e., a landing zone for applications"* — a Kubernetes namespace, AWS region, or Azure subscription. *"Environments are where Resource Types, Recipes, and cloud providers come together,"* and critically *"the Environment also defines the set of Recipes to be used for each Resource Type."* The same app deployed to two Environments gets two different infra realizations.

### Recipes — environment-specific infrastructure provisioning

- **What they are.** *"Recipes define the resource deployment implementation"* — *"infrastructure-as-code templates used to deploy an application's infrastructure, while guaranteeing it meets cost, operations, and security requirements."* Radius *"supports deploying resources using either Terraform or Bicep,"* letting teams reuse existing Terraform modules.
- **Contract.** A recipe template *"automatically receives a `context` parameter injected by Radius"* (info about the calling resource), takes typed parameters for customization, and must output a **`result`** object with three fields: **`values`** (fields the target resource requires), **`secrets`** (sensitive fields), and **`resources`** (the UCP IDs of the backing resources). Radius injects those outputs back into the app.
  ```bicep
  param context object          // Radius-provided: info about the calling resource
  param port int = 6379
  // ... provision infra ...
  output result object = {
    values:  { host: '...', port: 6379, username: '' }
    secrets: { password: '' }
    resources: [ '/planes/kubernetes/local/namespaces/.../Service/...' ]
  }
  ```
- **Registration & selection (the platform seam).** A recipe is published (`rad bicep publish --file myrecipe.bicep --target br:ghcr.io/USER/recipes/myrecipe:1.1.0`) and **registered to an Environment for a Resource Type**:
  ```bash
  rad recipe register myrecipe --environment myenv \
    --resource-type Applications.Datastores/redisCaches \
    --template-kind bicep --template-path ghcr.io/USER/recipes/myrecipe:1.1.0
  # or: --template-kind terraform --template-path user/recipes/myrecipe --template-version "1.1.0"
  ```
  Developers *"'mix and match' resources in any combination and swap out the backing Recipe depending on which environment they are targeting"* — the **same app definition** lands on a dev Redis, a canary cache, or a managed prod cluster purely by which recipe the Environment binds. In-app, a resource opts into a named recipe with `recipe: { name: 'myrecipe' }` (or takes the Environment default).

### Connections & auto-configuration

- **Connections** are declared from a container to another Radius resource; *"when a connection is declared from a container to another Radius resource, Radius injects environment variables with connection information."*
  ```bicep
  resource demo 'Applications.Core/containers@2023-10-01-preview' = {
    name: 'demo'
    properties: {
      application: application
      container: { image: '...', ports: { web: { containerPort: 3000 } } }
      connections: {
        redis: { source: db.id }          // <- the connection
      }
    }
  }
  resource db 'Applications.Datastores/redisCaches@2023-10-01-preview' = {
    name: 'db'
    properties: { application: application, environment: environment }   // recipe-backed
  }
  ```
- **Auto-injection.** Env vars follow a predictable naming convention derived from the connection name and resource type — e.g. a connection named `database` to Mongo yields `CONNECTION_DATABASE_CONNECTIONSTRING`, `CONNECTION_DATABASE_DATABASE`, `CONNECTION_DATABASE_USERNAME`, `CONNECTION_DATABASE_PASSWORD`. Connection info is *"securely managed by the Radius Environment, ensuring it is stored and mounted correctly,"* and developers can override with their own values. Connections are declarative wiring + configuration; they are **the direct analog of HoBo's `.allow()`/`bind`** (below), though Radius connections express reachability/config injection rather than a verb-scoped least-privilege grant.

### The Application Graph

- *"A core primitive of Radius Applications … a comprehensive representation of an application and its resources, including its environments and connections"* — *"a graph-like data set that reveals precisely how the resources within the application are interconnected."* It is built **automatically** from the declared connections/dependencies: *"this data is generated automatically as part of the Radius application development process, so it is always up to date without requiring additional effort from developers."* It spans both Kubernetes components and external cloud infrastructure in one view.
- **Consumed three ways:** the **`rad app graph`** CLI (*"view the application graph with its resources and connections in a terminal window"*), the web **Dashboard** (textual + visual representation of Applications/resources plus a directory of available Recipes), and an **HTTP API** for custom queries.

### `rad` CLI & Dashboard

- **`rad init`** installs Radius, *"Create[s] new environment default"*, and *"Scaffold[s] application"* (a sample `app.bicep`). **`rad run ./app.bicep`** deploys to a local Kubernetes cluster and *"sets up port forwarding from localhost to the container"*; **`rad deploy`** deploys to a named Environment.
- Other commands: **`rad app graph`** (visualize), **`rad recipe register|list`** (manage recipes), **`rad env`** (create/list/switch Environments), **`rad resource`** / **`rad group`** (UCP resources + resource groups), **`rad install kubernetes`** (install the control plane), **`rad bicep publish`** (publish templates to an OCI registry).
- The **Dashboard** is a shipping web UI for the app graph, resource inventory, and the recipe catalog — a real operator surface, not a design sketch.

### Multi-cloud, Dapr & providers

- **Providers** are the cloud credentials/integrations (Kubernetes, AWS, Azure) an Environment uses, managed separately from developer credentials. Radius is *"open-source and multi-cloud from the start,"* deploying across dev environments, on-prem, and public clouds with one toolchain.
- **Dapr is built into Radius**, so apps can use Dapr's microservice building blocks (state stores, pub/sub) as first-class app resources.

## Architecture

- **Control plane** — the Radius control plane runs **on Kubernetes**, as controllers plus an API
  server, reconciling Applications, Environments and Resource Types.
- **Data plane** — applications deploy primarily as Kubernetes workloads, with cloud resources
  provisioned alongside them by recipes.
- **Execution model** — deploying an Application resolves each Resource Type through the Environment's
  bound Recipe, then executes that recipe's Terraform or Bicep backend; Connections are resolved into
  injected configuration afterwards.
- **State authority** — Kubernetes resources plus the recipe backends' own state (Terraform state or
  ARM deployment history). Reconciled and declarative; no event log and no decision replay.
- **Application graph derivation** — the graph is derived from declared Connections and provisioned
  resources rather than maintained by hand, which is why it stays current.
- **Portability boundary** — recipes make *infrastructure* swappable per environment; the control
  plane and the workload substrate remain Kubernetes. The abstraction is portable across clouds, not
  across runtimes.

## Where Radius is stronger

> Shipped, evidenced capability only. Several of these are things HoBo has as design and Radius has
> as running software — that asymmetry is the point of this section.

### What Radius does well — and what HoBo borrows

- **A mature, shipping app-model + recipe ecosystem.** Radius is a real CNCF Sandbox project with a stable Application/Environment/Resource-Type model, a **shipping Dashboard**, an app-graph API, and a growing recipe catalog. HoBo's equivalents are **designed, not shipping** — credit Radius for proving the model in production.
- **Clean dev-vs-platform separation.** The developer authors an abstract app; the operator owns Environments + Recipes + policy. This is precisely the seam HoBo adopts (`bindle()` vs `camp()`/`yard()`), and Radius is the clearest reference implementation of it ([vision.md:72](../design/vision.md)).
- **Recipes as portable equivalence classes.** One Resource Type, many environment-bound implementations (Terraform *or* Bicep), swappable with no app change — the concept HoBo generalizes as **Resource Definitions + provider equivalence classes + Matching**.
- **Auto-built Application Graph** spanning K8s + cloud infra, always current, with CLI/Dashboard/API surfaces — a strong "understand the whole app" story.
- **Multi-cloud + on-prem** with reused Terraform modules, and **Dapr built in**.
- **Apache-2.0, vendor-neutral (CNCF)** governance.

## Where HoBo is stronger or intentionally different

State labels below follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. The original capture was written
when more of this was design; where a claim is still design-only it says so. See the
[live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Radius's limits, and what HoBo does instead

- **Kubernetes-centric today.** The Radius control plane runs on Kubernetes and apps deploy primarily as K8s workloads; there is no bespoke portable runtime. HoBo's substrate is a **wasm-default polyglot runtime** on a self-hosted wasmCloud lattice ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) — K8s is one target, not the floor.
- **Bicep / IaC-file authoring, not code-first IfC.** Apps are declared in **Bicep** and recipes in **Bicep/Terraform** — declarative IaC files, not resources declared inline in general-purpose application code. HoBo is **Infrastructure-from-Code**: resources + wiring declared in-code and collected by running the component, with `.allow()` driving least-privilege ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **Connections carry no verb-scoped least-privilege.** Radius connections inject config/env vars and express reachability, but a single declaration does not simultaneously mint a least-privilege IAM grant, a wasm capability link, and an agent token scope. HoBo's **`.allow(verbs)` is one declaration with three effects** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **No durable, event-sourced app runtime.** No actors / durable workflows / choreography sagas / replay/audit as a runtime concern. HoBo is **event-sourced end-to-end** — an append-only log as source of truth, CQRS, virtual actors, saga compensation ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No wasm / component-model runtime** — no polyglot-via-components, no capability-security-by-linking. HoBo's contract is language-neutral **WIT** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).
- **Recipe selection is a static Environment binding, not an auditable cost-routed decision.** An Environment names one Recipe per Resource Type; there is no recorded, replayable "*why did this resource land on this infra?*" and no budget-aware routing of the choice. HoBo's **Matching** records the winner, its score, rejected candidates, and the objective as a **`match.Decided`** event ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)), and the credit/budget-aware **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) cost-routes realization.
- **No agents-as-principals, no generation pipeline.** The AI story is *Resource Types make swapping model providers easier* — real, but it is not agents-as-first-class-identities or AI-generated providers/implementations. HoBo issues agents SVIDs + brokered tokens + an MCP control surface ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) and **generates + certifies** providers and impls ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).

## Adversarial critique

- **Kubernetes is the floor, not a target.** The control plane runs on Kubernetes and applications
  deploy primarily as Kubernetes workloads. "Multi-cloud" means recipes provision cloud resources;
  it does not mean the application runs somewhere that is not a cluster.
- **Bicep is a niche authoring language.** Outside the Azure ecosystem, Bicep is unfamiliar, and
  choosing it as the application-authoring surface narrows the addressable audience regardless of
  the model's quality.
- **Static Environment→Recipe binding cannot express conditional realization.** One recipe per
  resource type per environment is predictable and inflexible: no budget-aware choice, no residency
  constraint, no candidate ranking, and no recorded rationale.
- **Recipes inherit their backends' failure modes** — Terraform state and drift, or Bicep/ARM
  deployment semantics — and surface them through an abstraction that did not create them.
- **Connections are reachability plus configuration, not authorization.** Injecting environment
  variables is not the same as minting a least-privilege grant; teams must still solve IAM
  separately, which is where most security incidents actually originate.
- **Sandbox-stage maturity and adoption.** CNCF Sandbox is the earliest tier; the ecosystem of
  recipes and the operational track record outside the founding vendor's orbit remain limited.
- **No decision record.** The application graph shows what exists; nothing explains why a given
  realization was chosen.

### Comparisons with adjacent tools

- **vs HoBo:** Radius is a **Bicep/K8s app-platform with operator-owned Recipes**; HoBo is a **code-first IfC → any-cloud, wasm-default, event-sourced, AI-native meta-cloud**. They **agree on the app-model + dev/platform seam** — HoBo borrows it deliberately — and diverge on substrate (wasm + event log vs K8s), authoring (in-code IfC vs Bicep files), and governance (auditable cost-routed Matching vs static Environment bindings). Adjacent, not head-on.
- **vs Nitric / Encore:** Nitric and Encore are **code-first IfC** (declare resources in app code); Radius is **IaC-file-first** (Bicep app + Bicep/Terraform recipes) with a stronger *operator/platform-engineering* posture (Environments, Recipes, Resource Types as an explicit IDP contract). HoBo takes IfC authoring from Nitric/Encore **and** the platform-rules layer from Radius/Humanitec.
- **vs Humanitec:** both formalize a platform-rules layer — Radius's **Environment → Recipe per Resource Type** is close to Humanitec's **Resource Definitions + Matching**. HoBo unifies both and adds **auditable `match.Decided`** selection ([Plan 25](../design/platform-engineering.md#plan-25)).
- **vs Crossplane:** shared DNA — reconciliation + dev/platform separation; HoBo names Crossplane/Radius together as the borrow-source for that seam ([vision.md:72](../design/vision.md)). Crossplane is a Kubernetes control plane for infra; Radius adds the app-graph + recipe layer on top.
- **vs Aspire / Dapr:** Aspire composes/wires for local-dev + deploy without owning cloud provisioning; Dapr gives portable building-block APIs via a sidecar. Radius **provisions** (via Recipes) and **embeds Dapr**; HoBo unifies WIT ports (Dapr-like portability) + provisioning (Recipe-like) on one wasm substrate.

**Net:** Radius is a **borrow-source, not a rival** — it is the cleanest shipping proof of the two ideas HoBo takes from it: an **operator-owned recipe/equivalence-class layer** and a **dev-vs-platform separation** over a portable app graph. HoBo's differentiation is everything under and around that seam: a **wasm-default polyglot runtime** and **durable event-sourced control+data plane** (Radius has neither), **code-first IfC with `.allow()`** (vs Bicep/IaC files), **auditable cost-routed Matching** (`match.Decided` vs a static Environment→Recipe binding), **any-cloud + pluggable IaC** beyond a K8s-hosted control plane, and **AI-native depth** (agents-as-principals + a generation pipeline). Radius validates the model HoBo borrows; HoBo generalizes it.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Radius concept (✅ designed at parity · ➕ goes further · ◐ thinner/less mature than Radius today · 🔜 planned). **Honesty note:** Radius is a **shipping CNCF platform**; HoBo is **design-phase** — where Radius has real running surface (Dashboard, app-graph API, recipe catalog) and HoBo has a design, that is flagged ◐/🔜.

| Radius concept | HoBo equivalent | Notes |
|---|---|---|
| **Recipes** (env-specific IaC templates per Resource Type) | **Resource Definitions + provider equivalence classes + Matching** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) | ➕ **the key borrow.** Same "one abstraction, many env-bound impls" idea; HoBo adds **auditable + cost-routed** selection (`match.Decided` + Dispatcher [ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) vs a static Environment binding |
| **Resource Types** (dev↔platform contract) | WIT-port resource abstractions + **Resource Definitions** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[Plan 25](../design/platform-engineering.md#plan-25)) | ✅ same contract seam; HoBo's interface is a **WIT world**, provider-authorable in any wasm language |
| **Application** (first-class app resource) | HoBo app / `bindle()` scope + manifest IR ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ groups resources + wiring into one deployable unit |
| **Application Graph** (auto-derived resource/connection graph) | **topology / resource graph** ([Plan 7](../design/developer-experience.md#plan-07)) + observability ([Plan 5](../design/reliability-observability-cost.md#plan-05)) | ◐ HoBo designs a multi-cloud topology/resource-graph view; **Radius ships a live app-graph API + Dashboard today** |
| **Connections** (`connections:` → auto-injected env vars) | **`.allow()` / `bind`** (WIT links) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ the direct analog; HoBo's one declaration mints **IAM grant + wasm capability link + agent token scope** (verb-scoped least-privilege), where Radius injects config/reachability |
| **Environments** (landing zones binding Recipes + providers) | **Camps** (per-env scopes) + Matching context ([Plan 25](../design/platform-engineering.md#plan-25)) | ✅ per-env realization of the same app; HoBo records the decision |
| **dev-vs-platform separation** | `bindle()` (dev, provider-agnostic) vs `camp()`/`yard()` (platform, provider-specific) ([vision.md:72](../design/vision.md)) | ✅ **explicitly borrowed from Crossplane/Radius** |
| Bicep app + Bicep/Terraform recipes (**IaC-file authoring**) | **code-first IfC** (resources inline in-code, collected by running the component) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ general-purpose code, not a DSL; IaC tools survive as **pluggable adapters underneath** |
| Terraform **and** Bicep recipe backends | **pluggable IaC adapters** (Pulumi · Crossplane · Terraform · OpenTofu), no single primary ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ per-workload/per-Camp choice via Matching |
| **`rad` CLI** (init/run/deploy/app graph/recipe/env) | `hobo` CLI (dev/up/down/collect/plan) + dashboard ([Plan 7](../design/developer-experience.md#plan-07)) | ◐/✅ designed at parity; Radius's CLI + Dashboard **ship today** |
| **Dashboard** (app graph + recipe catalog) | HoBo dashboard + run inspector / replay / topology ([Plan 7](../design/developer-experience.md#plan-07)) | ◐ designed; Radius's is a real shipping web UI |
| Runs on **Kubernetes**; apps = K8s workloads | **wasm-default runtime** on a wasmCloud lattice; K8s is one target ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ not K8s-bound; polyglot components + capability security |
| **Dapr** built-in (state/pub-sub building blocks) | WIT ports (`wasi:keyvalue`/`wasi:messaging`/…) as the building-block contract ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ✅/➕ portable building blocks as WIT rather than a sidecar |
| Resource Types **for AI apps** (swap model providers) | agents-as-principals + MCP ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) + generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) | ➕ AI-native as identity + generation, not only an abstraction to swap models behind |
| *(none — no bespoke runtime)* | **durable event-sourced runtime**: log-as-truth, CQRS, actors, sagas ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ replay / audit / time-travel as a runtime property |
| *(Environment binding, not recorded)* | **auditable Matching** — `match.Decided` records winner + ranking + rejected + objective ([Plan 25](../design/platform-engineering.md#plan-25)) | ➕ replayable "why did this land here?" |
| Apache-2.0, CNCF vendor-neutral | HoBo OSS; **self-host = hosted parity** (the Yard is a Bindle); monetization out of design scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ✅ OSS posture |

## Better-together / integration posture

- **Borrow** — the posture [`lineage.md`](../design/lineage.md) already records, and this capture
  reaffirms it: the Recipe (an operator-owned, environment-bound realization behind a
  developer-facing Resource Type) and the developer/operator separation are taken deliberately. The
  section below states exactly what HoBo adds on top.
- **Benchmark** — the shipping Dashboard, the live application-graph API, and the recipe catalog are
  the bar for HoBo's equivalent surfaces, all of which are thinner today.
- **Standard-adjacent** — Radius, OAM/KubeVela and HoBo converge on the same role separation;
  speaking that shared vocabulary lowers HoBo's explanation cost.
- Not a displace target. Radius is adjacent, not head-on, and this capture does not inflate the
  overlap: it is a borrow-source first.

## Threats and lessons

1. **Radius proves the seam HoBo bets on, which is reassuring and dangerous.** A CNCF project
   shipping the developer/operator separation validates the model — and means HoBo cannot claim the
   idea, only its generalization: scored selection, recorded decisions, non-Kubernetes substrates.
2. **Shipping surface beats designed surface in evaluations.** A live application graph and
   Dashboard are what a prospect sees first. This is the fifth independent occurrence in this corpus
   of the same missing HoBo surface, and it should be its own implementation issue rather than a
   recurring note.
3. **Recipe selection is the weak point to press on.** A static environment binding cannot answer
   "why here?" — and that question is exactly what regulated and cost-sensitive buyers ask. HoBo's
   `match.Decided` is the answer, and it should be demonstrated rather than described.
4. **Authoring-language choice is strategic.** Radius's Bicep bet narrows its audience; the lesson
   for HoBo is that its own TypeScript-plus-CUE split needs to stay ordinary enough to avoid the
   same trap.

## What HoBo takes from Radius, and how it generalizes it

Radius's **Recipe** — an operator-owned, environment-bound, IaC-backed implementation behind a developer-facing Resource Type — is the concrete shape HoBo adopts for its **Resource Definitions + provider equivalence classes** ([Plan 25](../design/platform-engineering.md#plan-25)). HoBo keeps the ergonomics (one abstract resource, many env-specific realizations, swap by binding not by app-edit) and adds three things Radius does not: (a) selection is **specificity-scored Matching**, not a single static Environment binding; (b) the choice is **recorded as a replayable `match.Decided` event** with the full ranking + rejected candidates + objective — an auditable answer to *"why did this resource land on this infra?"*; and (c) the realization is **cost-routed** by the credit/budget-aware Dispatcher ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)). The **dev-vs-platform separation** — Radius's Developers-define-Applications / Operators-define-Environments — is borrowed wholesale as HoBo's `bindle()` vs `camp()`/`yard()` scopes ([vision.md:72](../design/vision.md)).

## The one-line takeaway

**Radius proves the app-model + operator-owned recipe/equivalence-class layer + dev-vs-platform separation that HoBo borrows** — and ships it as a real CNCF platform with a live app graph, Dashboard, and recipe ecosystem. But Radius is **Kubernetes-hosted, Bicep/IaC-file-authored, runtime-less (no durable event-sourced app runtime, no wasm), with static (non-auditable, non-cost-routed) recipe selection and no agents-as-principals/generation pipeline.** HoBo takes the borrowed seam and rebuilds it on a **wasm-default, event-sourced, code-first IfC, any-cloud, AI-native** substrate with **auditable cost-routed Matching** — adjacent to Radius, not head-on.

## Sources

- [Radius documentation](https://docs.radapp.io/concepts/) — Applications, Environments, Resource Types, Recipes, Connections, application graph
- [radapp.io](https://radapp.io/) — positioning and project status
- [radius-project/radius](https://github.com/radius-project/radius) — source, Apache-2.0 licence, CNCF Sandbox status
- HoBo-side: [`design/lineage.md`](../design/lineage.md), [`standards/oam`](../standards/oam.md), and the plan/ADR references cited inline throughout this capture

This capture was first written before the research contract existed and was restructured to it on
2026-08-19; its original research is preserved. Recipe-catalog breadth and current adoption evidence
were not re-verified in this pass and are not asserted.

