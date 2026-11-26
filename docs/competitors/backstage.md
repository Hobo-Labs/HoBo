---
type: Competitive Reference
title: "Backstage — competitor reference"
description: "Backstage is an **open-source framework for building developer portals** (Spotify, CNCF Incubating; Apache-2.0) — a **software catalog, software templates (scaffolder), TechDocs, and a plugin system** you assemble and self-host as a React/Node app. It is an **adjacent** categor"
tags: [hobo, competitors]
competitor:
  slug: backstage
  name: "Backstage"
  aliases: ["spotify backstage"]
  primary_category: developer-portals-idps
  categories: [developer-portals-idps]
  directness: complementary
  role: "CNCF developer portal framework — complementary front-end to a HoBo control plane"
  posture: [integrate, borrow]
  hobo_surface: [governance, ecosystem, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://backstage.io/docs/overview/what-is-backstage/
    - https://github.com/backstage/backstage
---

# Backstage — competitor reference

> A faithful capture of **Backstage** for HoBo competitive analysis. Backstage is a different **category** from HoBo: it is a **developer-portal / internal-developer-platform (IDP) *framework*** — a **software catalog**, **software templates (scaffolder)**, **TechDocs**, **search**, and a **plugin system** you assemble into a self-hosted React/Node app — a **presentation + metadata + workflow-launcher layer over your existing tooling**, *not* a runtime, control plane, or provisioner. HoBo is a **control plane + durable runtime**. They are **complementary, not head-on**: Backstage's catalog/templates/portal map onto HoBo's dashboard/status pages, Resource Packs, and generated developer catalog — and a Backstage instance could plausibly be a **presentation layer over a HoBo Yard**. Sources: [backstage.io](https://backstage.io/) · [backstage.io/docs](https://backstage.io/docs/overview/what-is-backstage/) · [github.com/backstage/backstage](https://github.com/backstage/backstage) · [backstage.io plugin marketplace](https://backstage.io/plugins) · [backstage.spotify.com](https://backstage.spotify.com/) · [CNCF project page](https://www.cncf.io/projects/backstage/). License **Apache-2.0** (framework + CLI + community plugins OSS; **Spotify Portal for Backstage** and the **premium Spotify plugins** are closed-source/commercial). Researched July 2026; API/CLI/schema shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Backstage is *"an open source framework for building developer portals."* Created at **Spotify in 2016**, open-sourced in **March 2020**, accepted into the **CNCF Sandbox (September 2020)** and promoted to the **CNCF Incubator (March 15, 2022)**, it is the reference implementation of the "internal developer portal" pattern — used by **thousands of organizations** (American Airlines, Expedia, Netflix, Zalando, and 100+ publicly listed adopters). Its pitch: *"Backstage restores order to your microservices and infrastructure and enables your product teams to ship high-quality code quickly — without compromising autonomy,"* and *"unifies all your infrastructure tooling, services, and documentation to create a streamlined development environment from end to end."*

The core product is four pillars plus an extension model:

- **Software Catalog** — *"for managing all your software,"* a metadata graph of `catalog-info.yaml` entities (Components, APIs, Resources, Systems, Domains, Groups, Users).
- **Software Templates** — *"for quickly spinning up new projects,"* a YAML **scaffolder** that renders a form, runs a sequence of **actions**, and registers the result back into the catalog.
- **TechDocs** — *"Spotify's homegrown docs-like-code solution,"* Markdown + MkDocs stored beside the code and rendered in-portal.
- **Search** — a unified search across catalog, docs, and plugin-contributed collators.
- **Plugins** — *"open source plugins that further expand Backstage's customizability and functionality,"* the mechanism by which every integration (Kubernetes, CI/CD, cloud, incident, cost, security) is surfaced.

The crucial framing for HoBo: **Backstage does not run, deploy, or provision anything.** It is a **portal**: it *catalogs* what exists, *launches* workflows (templates call out to Git/CI/cloud), and *surfaces* the state of external systems through read-mostly plugins. You **build and host it yourself** — `npx @backstage/create-app@latest` scaffolds a **React (frontend) + Node.js (backend) monorepo** backed by **PostgreSQL**, configured through `app-config.yaml`, which **you deploy to your own infrastructure** (frontend on `:3000`, backend on `:7007` in dev). There is no managed runtime, no resource provisioning, no durable execution, no scheduler, and no first-class agent identity — those live in the systems Backstage *points at*. This is exactly the layer HoBo would **sit underneath and feed**, not compete with.

| Dimension | Backstage |
|---|---|
| Category | **Developer portal / IDP *framework*** — catalog + templates + docs + plugins; a presentation/metadata/workflow layer, **not** a runtime or control plane |
| Core pillars | **Software Catalog · Software Templates (Scaffolder) · TechDocs · Search · Plugins** |
| Catalog model | `catalog-info.yaml` entities — `Component`/`API`/`Resource`/`System`/`Domain`/`Group`/`User`/`Location`/`Template` + well-known relations (`ownedBy`/`providesApi`/`consumesApi`/`dependsOn`/`partOf`) |
| Templates | `scaffolder.backstage.io/v1beta3` `Template` — `spec.parameters` (react-jsonschema-form) + `spec.steps` (built-in **actions** `fetch:template`/`publish:github`/`catalog:register`/…) + `spec.output` |
| Docs | **TechDocs** — docs-like-code: Markdown + `mkdocs.yml` beside the code, rendered in the portal |
| Extensibility | **Plugins** (frontend React + backend Node) + **Modules** + **Extension Points** (new backend system); **140+** marketplace plugins + a large community set |
| Runtime / provisioning | **None.** Backstage runs *itself*; it neither executes your services nor provisions cloud resources. Plugins **surface** external systems (K8s, CI/CD, cloud) read-mostly |
| How you run it | Self-hosted **React + Node monorepo** (`npx @backstage/create-app`), **PostgreSQL**-backed catalog, `app-config.yaml`; **you host and maintain it** |
| Auth / permissions | Pluggable **auth** providers; **opt-in permission framework** (`PermissionPolicy` authored in **TypeScript**) — **no built-in RBAC UI** in core (Red Hat/Janus or Spotify supply RBAC) |
| AI | **None in core**; Spotify's **AiKA** AI knowledge assistant is a commercial plugin |
| Origin / governance | **Spotify** (2016) → OSS (Mar 2020) → **CNCF Sandbox** (Sep 2020) → **CNCF Incubating** (Mar 15, 2022) |
| License / commercial | **Apache-2.0** OSS core; **Spotify Portal for Backstage** (no-code managed distribution, GA **Oct 2025**) + **premium Spotify plugin bundle** (Soundcheck, RBAC, Skill Exchange, Insights, Pulse, AiKA) — **closed-source, annual subscription, contact-sales** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Catalog entity** | Component, System, API, Resource, Group, User — declared in `catalog-info.yaml` files in the customer's own repositories |
| **Software Template** | A scaffolder template that generates a new repository along a golden path |
| **TechDocs** | Docs-as-code: repository Markdown compiled into searchable documentation |
| **Plugin** | The extension unit — and, upstream, a build-time dependency compiled into the customer's own Backstage image |
| **Processor / provider** | Catalog ingestion extension points |

The mental model is **a framework, not a product**: Backstage ships the primitives and the customer
builds their portal from them. That is the source of both its ecosystem and its cost — the same
decision that produced Roadie and Red Hat Developer Hub as businesses.

## How it competes with HoBo

Backstage is **complementary by construction**, and [`lineage.md`](../design/lineage.md) already
records the posture: a portal HoBo should feed, not replace.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `app-graph` | The catalog is the de-facto standard representation of an engineering estate |
| `extensibility` | The largest plugin ecosystem in the developer-portal category |
| `governance` | Templates standardize how new work starts; permissions govern who sees what |

Backstage surfaces and links; it does not decide, place, or execute. The contest is over the
developer's attention, not over the control plane.

## Feature surface

### Software Catalog — `catalog-info.yaml` entities

The catalog is *"built around the concept of metadata YAML files stored together with the code."* The recommended descriptor filename is **`catalog-info.yaml`**; a `Location` entity (or an integration's discovery) tells Backstage where to harvest them. A minimal **Component**:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: artist-web
  description: The place to be, for great artists
  annotations:
    example.com/service-discovery: artistweb
  tags:
    - java
spec:
  type: website
  lifecycle: production
  owner: artist-relations-team
  system: public-websites
  providesApis:
    - artist-api
  dependsOn:
    - resource:default/artists-db
```

**Core entity kinds** (the metamodel HoBo's resource graph parallels):

| Kind | What it is |
|---|---|
| **Component** | A software unit with deployable artifacts, usually tied to source (`spec.type`: `service` / `website` / `library`; `spec.lifecycle`: `experimental` / `production` / `deprecated`) |
| **API** | An interface a Component exposes/consumes — OpenAPI, AsyncAPI, GraphQL, gRPC |
| **Resource** | Infrastructure a Component needs to run — databases, buckets, topics, CDNs |
| **System** | A collection of Components + Resources that expose/consume a set of APIs |
| **Domain** | A group of Systems sharing terminology/models — a bounded context |
| **Group** / **User** | Org entities — teams/units and the people in them (ownership + auth) |
| **Location** | A marker pointing at other places to harvest catalog data |
| **Template** | A scaffolder definition (see below) |

Relations are **read-only and derived** by catalog processors: `ownedBy`/`ownerOf`, `providesApi`/`apiProvidedBy`, `consumesApi`/`apiConsumedBy`, `dependsOn`/`dependencyOf`, `partOf`/`hasPart`. The catalog is a **descriptive graph of what exists and who owns it** — it records topology and ownership; it does **not** cause anything to be provisioned. That distinction (a *catalog* vs a *control plane*) is the whole story of the HoBo relationship.

### Software Templates — the scaffolder

A **Template** is *"a small YAML definition which describes the template and its metadata, along with input variables … and then a list of actions which are then executed by the scaffolding service."* It has three `spec` sections — **`parameters`** (form fields, *"based on react-jsonschema-form"*), **`steps`** (an ordered list of **actions**), and **`output`** (links/refs shown on completion):

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: v1beta3-demo
  title: Test Action template
  description: scaffolder v1beta3 template demo
spec:
  owner: backstage/techdocs-core
  type: service
  parameters:
    - title: Fill in some steps
      required: [name]
      properties:
        name:
          title: Name
          type: string
          ui:autofocus: true
        owner:
          title: Owner
          type: string
          ui:field: OwnerPicker
          ui:options: { catalogFilter: { kind: Group } }
    - title: Choose a location
      required: [repoUrl]
      properties:
        repoUrl:
          title: Repository Location
          type: string
          ui:field: RepoUrlPicker
          ui:options: { allowedHosts: [github.com] }
  steps:
    - id: fetchBase
      name: Fetch Base
      action: fetch:template
      input:
        url: ./template
        values: { name: ${{ parameters.name }}, owner: ${{ parameters.owner }} }
    - id: publish
      name: Publish
      action: publish:github
      input:
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: 'main'
    - id: register
      name: Register
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: '/catalog-info.yaml'
  output:
    links:
      - title: Open in catalog
        icon: catalog
        entityRef: ${{ steps['register'].output.entityRef }}
```

Steps invoke **built-in actions** — `fetch:template`, `fetch:plain`, `publish:github`, `catalog:register`, `debug:log`, `npm:publish`, `deploy:kubernetes`, and many plugin-contributed ones (browsable at `/create/actions`) — wired together with `${{ parameters.* }}` / `${{ steps.*.output.* }}` templating. Two things matter for HoBo: (1) a template is a **one-shot code-generation + Git/CI/cloud-orchestration recipe**, closest to HoBo's **Resource Packs / Workload Profiles**, not to a running system; and (2) it **hands off** actual provisioning to external actions (`publish:github` → your CI → your IaC). Backstage launches the workflow; it doesn't own the reconcile loop or the running result.

### TechDocs

TechDocs is *"Spotify's homegrown docs-like-code solution built directly into Backstage."* Engineers *"write their documentation in Markdown files which live together with their code,"* declare an `mkdocs.yml`, and *"with little configuration get a nice-looking doc site in Backstage,"* leveraging *"the large ecosystem of MkDocs plugins."* It is a docs-rendering + hosting pillar of the portal — orthogonal to HoBo, though HoBo's generated developer catalog + status pages cover overlapping "where do I read about this service" ground.

### Plugin architecture

Every integration in Backstage is a **plugin**. The frontend plugin API (`@backstage/frontend-plugin-api`, `createFrontendPlugin`) contributes pages, nav, and Utility APIs; the **new backend system** models the server side as **Plugins**, **Services**, **Extension Points**, and **Modules**:

- **Plugins** *"provide the actual features … each plugin can be considered to be its own microservice"* — they may not call each other in-process; cross-plugin communication is over the wire.
- **Services** are shared utilities (logging, DB access, config) so plugins don't reimplement plumbing.
- **Extension Points** are the typed seams a plugin exposes for customization (e.g. catalog **entity providers**, scaffolder **custom actions**).
- **Modules** *"extend plugins or other modules"* and *"must always be installed in the same backend instance as the plugin … they extend,"* interacting only through that plugin's extension points.

This is a **rich, mature ecosystem** — a **plugin marketplace with 140+ open-source plugins** (Kubernetes, GitHub Actions, ArgoCD, SonarQube, Snyk, PagerDuty, Prometheus, Tech Insights, …) plus a large community set and vendor plugins (Roadie, Red Hat Developer Hub, Harness, Spotify). **Ecosystem breadth and portal maturity are where Backstage is decisively ahead of a design-phase HoBo.**

### Kubernetes & CI/CD plugins (surfacing, not controlling)

The **Kubernetes plugin** is *"a tool that's designed around the needs of service owners, not cluster admins,"* letting developers *"easily check the health of their services no matter how or where those services are deployed"* — it **surfaces** deployments/pods/objects for an entity across clusters (mapped to a Component via `backstage.io/kubernetes-id` labels/annotations). CI/CD plugins (GitHub Actions, ArgoCD, etc.) likewise **display** pipeline/rollout state on the entity page. The pattern is **read-mostly visibility**: Backstage shows you what other systems are doing; the provisioning, scheduling, and reconciliation happen **outside** Backstage. It is a **window onto** a control plane, not a control plane.

### Search, auth & permissions / RBAC

**Search** federates catalog + TechDocs + plugin collators. **Authentication** is pluggable (OAuth/OIDC providers). The **permission framework** is **opt-in** — *"by default, Backstage endpoints are not protected, and all actions are available to anyone"* — and delegates each decision to a **`PermissionPolicy`** *"specified by the integrator using code, a provided authorization method (such as RBAC), or integrations with external authorization providers,"* returning ALLOW/DENY with support for **conditional/resource-scoped** decisions. Crucially, **core Backstage ships no RBAC UI**: policies are **authored in TypeScript**, and turnkey role management comes from **Red Hat/Janus' RBAC plugin** or **Spotify's commercial RBAC**. Permissions here govern **who can see/do what *in the portal*** — a different scope from HoBo's **org-governance / policy planes** that gate real deploys and platform mutations.

### Backstage Portal & Spotify commercial (not a HoBo concern)

Assembling and operating open-source Backstage is real engineering (a React/Node monorepo you build, upgrade, and run). To lower that bar, **Spotify** offers **Portal for Backstage** — previewed May 2024 as a **no-code**, *"Backstage in a box"* distribution (*"Fast setup with no coding required,"* a *"friendly plugin installer,"* a working portal *"in under 10 minutes"*) and made **generally available in October 2025** as a **commercial product**. Alongside it, the **premium Spotify plugin bundle** — **Soundcheck** (standards/scorecards), **RBAC**, **Skill Exchange**, **Insights** (analytics), **Pulse** (surveys), and **AiKA** (AI knowledge assistant) — is **closed-source (license owned by Spotify)** and sold as an **annual subscription flexed to Backstage usage/capacity, no public list price, contact-sales**. These *"complement the open source platform,"* and revenue *"can be reinvested into developing … more plugins."* For HoBo this is simply out of scope: **HoBo takes monetization out of design scope entirely** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)), so Spotify's commercial layer is neither a competitive threat nor a template HoBo follows.

## Architecture

- **Control plane** — a Node.js application the customer builds, deploys and operates. Upstream
  Backstage is delivered as a scaffolded codebase, not a binary.
- **Data plane** — none. Every plugin surfaces another system; Backstage controls nothing.
- **Catalog ingestion** — entities are declared in `catalog-info.yaml` files discovered from
  repositories, then processed and enriched.
- **Plugin composition is build-time**, which is the architectural fact that drives the whole
  ecosystem around it: adding a plugin means changing code, rebuilding an image, and re-merging on
  every upgrade. Red Hat's dynamic plugin loading exists to undo exactly this.
- **State authority** — the customer's repositories for entity declarations; the catalog database is
  a projection.
- **Portability boundary** — excellent for the model (upstream YAML in the customer's repos), poor
  for the deployment (a bespoke fork the customer maintains forever).

## Where Backstage is stronger

> Shipped, evidenced capability only.

### what Backstage does well

- **The canonical developer-portal metamodel.** `catalog-info.yaml` + entity kinds + derived relations is the industry-standard way to describe *"what software exists, who owns it, and how it relates."* It's a clean, adopted, faithfully-designed graph.
- **A mature, opinionated scaffolder.** Templates (form → actions → catalog registration) are a battle-tested golden-path launcher, with a broad action library.
- **A huge, mature plugin ecosystem.** 140+ marketplace plugins plus a large community/vendor set — years ahead of any design-phase platform on **integration breadth**, and the reason Backstage is the default IDP substrate.
- **A real extension architecture.** Frontend plugins + the new backend system (Plugins/Services/Extension Points/Modules) give principled, independently-versioned extensibility.
- **CNCF-Incubating, vendor-neutral, Apache-2.0**, with enormous adoption and a commercial on-ramp (Spotify Portal) for teams that don't want to self-operate.
- **TechDocs** — docs-like-code is a genuinely good, well-integrated pillar.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Backstage's limits — where HoBo lives, *underneath*

These are **category boundaries**, not defects — Backstage is deliberately a portal. But each is a thing HoBo *is* and Backstage *is not*:

- **No runtime.** Backstage never executes your workloads; there is no wasm/OCI host, no scheduler, no durable/event-sourced execution, no actors/workflows. HoBo is a **wasm-default durable runtime** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) with an **event-sourced, replayable** substrate ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No provisioning / control plane.** The catalog *records* Resources; it doesn't create them, and templates hand provisioning to external CI/IaC. HoBo is **cloud-agnostic provisioning** via WIT ports + pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) with **Resource Definitions + Matching + Deployment Sets** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) so "same app → different infra per env" is an **auditable** decision.
- **No IfC authoring / `.allow()`.** There is no "declare a resource in app code and have the platform provision + least-priv-wire it." HoBo's **IfC + `.allow()`** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) turns one declaration into IAM + capability grant + agent-token scope.
- **Plugins surface, they don't abstract.** A Backstage plugin is a **portal integration** (fetch + render another system's state); it is **not** a swappable capability port with an equivalence class. HoBo's plugin analog is **WIT ports/adapters** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) — the same building block runs locally, cross-cloud, or against a different provider with no app change.
- **AI is not native.** Core Backstage has no AI; agents are not principals, there's no MCP control surface, no Operator Crew, no generation pipeline. The only AI is Spotify's commercial **AiKA** assistant. HoBo makes **agents first-class principals** with a Capability Manifest + MCP + Operator Crew ([Plan 6](../design/ai-native-agent-auth.md#plan-06)/[Plan 40](../design/operators-sre.md#plan-40)) and an **AI generation pipeline** for providers/impls ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **Portal-scoped permissions only.** The permission framework governs portal actions (opt-in, code-authored, no core RBAC UI); it does not gate real deploys or platform mutations. HoBo's **org governance** ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) governs the platform itself.
- **You build and operate the portal.** OSS Backstage is a React/Node monorepo you assemble, upgrade, and host (or pay Spotify to). That's the *portal* — it says nothing about running your *product*.

## Adversarial critique

- **The maintenance burden is the defining criticism**, and it is structural rather than incidental:
  a build-time plugin model plus a fast-moving upstream means every installation is a fork with a
  permanent upgrade cost. An entire commercial category — Roadie, Red Hat Developer Hub, and others
  — exists to sell relief from it.
- **Declared catalogs go stale.** `catalog-info.yaml` describes what someone said was true; the
  auto-discovering competitors in this cohort are attacking a real failure mode.
- **It is a framework sold as a portal.** Adoption is an engineering project with staffing, not a
  purchase, and organizations routinely underestimate that.
- **Plugin quality is uneven**, as in any large community ecosystem, and the plugin surface is also
  the security surface — plugins run inside the portal with its credentials.
- **No enforcement.** Backstage can show that a service lacks an owner; it cannot prevent the next
  one from shipping without one.
- **Spotify's stewardship plus a commercial offering** is a normal and healthy arrangement that
  adopters should still evaluate, as with any vendor-led open-source project.

### Comparisons with adjacent tools

- **vs HoBo:** Different layers of the stack. **Backstage is the *portal* (catalog + templates + docs + plugins over your tools); HoBo is the *control plane + runtime* (provision + run + govern).** They are **complementary**: Backstage answers *"what exists and how do I start something,"* HoBo answers *"make it exist and keep it running, anywhere, auditably."* A Backstage catalog could be **fed from** HoBo's resource graph, and a Backstage instance could be a **presentation layer over a HoBo Yard**. HoBo does **not** aim to be a portal framework — that is squarely Backstage's domain.
- **vs Humanitec / Nomad (control-plane competitors):** those are closer to HoBo's category (orchestration/platform-orchestrator). Backstage is the **UI/catalog** teams put *in front of* a Humanitec or a Nomad — it composes with control planes rather than being one.
- **vs Encore / Nitric / Amplify (IfC frameworks):** orthogonal. Those are *authoring + provisioning* frameworks with no portal; Backstage is a *portal* with no authoring/provisioning. HoBo spans both concerns and could surface through Backstage.
- **vs Roadie / Red Hat Developer Hub / Harness IDP:** commercial Backstage distributions/hosts — same category as Spotify Portal, all downstream of the OSS project; none change the portal-vs-runtime distinction with HoBo.

**Net:** Backstage is the **canonical developer portal** and the clearest proof that the **catalog + golden-path-templates + plugin** model is what teams want at the *surface* — and its **ecosystem + portal maturity are genuinely ahead of design-phase HoBo**. But it is a **presentation/metadata/workflow-launcher layer with no runtime, no provisioning, no durable execution, no native AI, and no platform-level governance.** HoBo is the **layer beneath**: the control plane + runtime that *makes the catalog's entries real and keeps them running*. The honest relationship is **complementary** — "HoBo is the platform Backstage would surface" — and the only place they touch is HoBo's own dashboard/status-pages + generated developer catalog, which cover a *slice* of Backstage's surface without HoBo ever trying to *be* Backstage.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Backstage concept (✅ has · ➕ goes further · ◐ partial/thinner · 🔜 planned). **Read the whole table as "adjacent surface overlap," not "head-on parity"** — Backstage is a portal; most rows map to HoBo's *dashboard/catalog/packaging* surface, and several Backstage strengths (plugin ecosystem, portal maturity) are places HoBo is **behind**, by design, because HoBo is not a portal framework.

| Backstage concept | HoBo equivalent | Notes |
|---|---|---|
| **Software Catalog** (`catalog-info.yaml` entity graph) | **Resource graph / topology + Registry** ([ADR-0062](../design/adr/07-portability-extensibility.md#adr-0062)) surfaced in the dashboard ([Plan 49](../design/developer-experience.md#plan-49)) | ◐/➕ HoBo *derives* the graph from the live manifest IR + running system (not hand-authored YAML); it's a **byproduct of provisioning**, not a separate metadata file |
| Entity kinds (Component/API/Resource/System/Domain) + relations | Resources = **WIT ports**, services = **components**, wiring = **manifest IR**; ownership/relations emerge from the graph ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ HoBo has the graph but **no portal metamodel / no catalog UX** at Backstage's depth |
| **Software Templates / Scaffolder** (form → actions → register) | **Resource Packs / Workload Profiles** ([Plan 25](../design/platform-engineering.md#plan-25)) | ◐/➕ HoBo's packs are reusable, matchable platform bundles rather than one-shot Git-scaffolding recipes; no visual form-builder yet |
| Scaffolder **actions** (`publish:github`, `deploy:kubernetes`, …) | provisioning is **first-class** via provider adapters + Matching ([Plan 4](../design/control-plane.md#plan-04)/[Plan 25](../design/platform-engineering.md#plan-25)) | ➕ HoBo *is* the reconcile loop; Backstage actions hand off to external CI/IaC |
| **TechDocs** (docs-like-code) | generated developer catalog + **status pages** ([Plan 49](../design/developer-experience.md#plan-49)/[Plan 07](../design/developer-experience.md#plan-07)) | ◐ overlapping "read about this service" surface; HoBo has **no MkDocs-grade docs pillar** |
| **Plugins** (frontend React + backend Node, marketplace) | swappable **WIT ports/adapters** + agent-skills ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 23](../design/generated-stack.md#plan-23)) | ◐/➕ different meaning: HoBo "plugins" are **capability adapters** (run the workload), not portal integrations (render a UI). **Backstage's ecosystem is far larger today** |
| Kubernetes / CI-CD plugins (surface state) | observability + topology + operations dashboard ([Plan 05](../design/reliability-observability-cost.md#plan-05)/[Plan 49](../design/developer-experience.md#plan-49)) | ◐/➕ HoBo *owns* the runtime it shows; Backstage *watches* someone else's |
| **Permission framework** (`PermissionPolicy`, portal-scoped, code-authored) | **org governance / policy planes** ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | ➕ HoBo governs **real deploys + platform mutations**, not just portal actions |
| Auth providers (OIDC) | per-route OIDC/JWT security + brokered principals ([Plan 06](../design/ai-native-agent-auth.md#plan-06)) | ✅/➕ |
| Self-host a React/Node monorepo (`create-app`) | **Yard-is-a-Bindle** self-host = hosted parity ([Plan 4](../design/control-plane.md#plan-04)) | ↔ different artifact — HoBo self-hosts the *platform*, Backstage self-hosts the *portal* |
| **Spotify Portal / premium bundle** (commercial) | *(out of scope)* — HoBo is OSS; **monetization out of design scope** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | n/a — not a HoBo concern |
| *(none — no runtime)* | **wasm-default durable, event-sourced runtime** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 11](../design/data-plane.md#plan-11)) | ➕ the category Backstage isn't in |
| *(none — no provisioning)* | **cloud-agnostic provisioning + pluggable IaC** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ |
| *(none — no IfC)* | **IfC + `.allow()`** (one decl → IAM + capability + agent scope) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ |
| *(none in core — AiKA is commercial)* | **agents as principals + MCP + Operator Crew + generation pipeline** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)/[Plan 40](../design/operators-sre.md#plan-40)/[Plan 23](../design/generated-stack.md#plan-23)) | ➕ AI-native by construction |

### Where Backstage is ahead (and HoBo should stay honest)

Credit where due: **Backstage's plugin ecosystem (140+ marketplace + large community/vendor set) and its portal/catalog UX maturity are years ahead of design-phase HoBo,** and its `catalog-info.yaml` metamodel is the de-facto industry standard for describing software estates. HoBo does **not** try to match this — it is **not a portal framework**. Where HoBo touches the surface (a dashboard, status pages, a generated developer catalog off the live resource graph), it deliberately covers only the slice that falls out of *owning the runtime*, and leaves rich portal-building to Backstage.

### The one-line takeaway

**Backstage is the portal; HoBo is the platform the portal points at.** Backstage catalogs, scaffolds, and surfaces — over tools it never runs — and its ecosystem/UX maturity are a real, ahead-of-HoBo strength; HoBo provisions, runs, and governs — cloud-agnostic, wasm-durable, event-sourced, AI-native — the substrate whose reality Backstage would *display*. They are **complementary, not competitive**: the natural end state is a Backstage instance rendering a **HoBo Yard**, with HoBo's resource graph feeding the catalog and HoBo doing the one thing Backstage structurally cannot — making the entries real and keeping them alive.

## Better-together / integration posture

- **Integrate** — the settled posture, and the right one: HoBo is a control plane that a Backstage
  portal can front. HoBo should be a first-class catalog source and a scaffolder action target.
- **Borrow** — **the entity model's role separation** (Component / System / API / Resource / Group /
  User) is a well-designed vocabulary, and **keeping the model in the customer's repositories** is a
  principle HoBo shares and states less clearly.
- **Standard** — `catalog-info.yaml` is a de-facto standard worth emitting rather than competing with.
- **Benchmark** — on ecosystem breadth, which HoBo will not match and should not try to.
- Not a displace target. Building a portal would be a strategic error, and this capture's purpose is
  partly to make that judgement explicit and durable.

## Threats and lessons

1. **Whoever owns the portal owns the developer relationship.** Six products in this cohort compete
   for that surface. HoBo's answer is to be the best thing behind it, and to make that integration
   trivial — which is a documentation and adapter task, not a product pivot.
2. **Build-time extension models create permanent cost.** Backstage's ecosystem is its strength and
   its plugin model is why distributions exist. HoBo's runtime-loaded components are the answer to
   this, and the argument should be made explicitly against this example.
3. **A declared catalog is a promise; a derived catalog is a fact.** HoBo's event log makes it a
   better catalog source than most systems Backstage ingests from, and that is a concrete
   integration pitch rather than an abstract advantage.
4. **The category's economics favour managed distributions.** Open source plus operational burden
   reliably produces a services market — a pattern worth remembering for HoBo's own open core.

## Sources

- [backstage.io](https://backstage.io/) and [what is Backstage](https://backstage.io/docs/overview/what-is-backstage/) — framework positioning, catalog, TechDocs, templates, plugins
- [backstage/backstage](https://github.com/backstage/backstage) — source, Apache-2.0, CNCF project status
- HoBo-side: [`design/lineage.md`](../design/lineage.md) records Backstage as a complementary portal, not a rival

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current plugin-ecosystem size, release cadence and the Spotify Portal
commercial offering were not re-verified in this pass and are not asserted.
