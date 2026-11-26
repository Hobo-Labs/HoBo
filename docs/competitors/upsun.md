---
type: Competitive Reference
title: "Upsun (Platform.sh) — Competitor Reference"
description: "Git-branch-as-environment PaaS: YAML-declared apps, services and routes, with production data cloned into every branch environment."
tags: [hobo, competitors]
competitor:
  slug: upsun
  name: "Upsun"
  aliases: ["platform.sh", "platformsh", "upsun fixed"]
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, platform-orchestrators]
  directness: overlapping
  role: "environment-per-branch PaaS whose cloned-production-data preview environments are the strongest ephemeral-environment implementation in the corpus"
  posture: [benchmark, borrow, provider-target]
  hobo_surface: [environments, authoring, delivery, app-graph, wiring]
  evidence: mixed
  status: renamed
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.upsun.com/learn/overview/yaml/yaml-structure.html
    - https://fixed.docs.upsun.com/learn/overview/structure.html
    - https://fixed.docs.upsun.com/add-services.html
    - https://fixed.docs.upsun.com/define-routes.html
    - https://api.upsun.com/docs/
---

# Upsun (Platform.sh) — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-19**.
>
> **Naming.** "Platform.sh is now Upsun." The docs distinguish **Upsun** (the current flexible
> product) from **Upsun Fixed** (the previous Platform.sh generation, still documented separately at
> `fixed.docs.upsun.com`). This capture is the single canonical entry for both; `platform.sh` is
> recorded as an alias in the [corpus index](index.md), and `status: renamed` in front matter.

## What it is

Upsun is a **commercial PaaS whose organizing idea is that a Git branch is an environment** — not a
deployment target you configure, but an entire running copy of production, including its data,
created automatically.

- **Product boundary.** Application hosting with managed services, routing, and environment
  lifecycle. Not an IaC tool, not a Kubernetes platform the user sees.
- **Operating model.** Fully managed SaaS on the vendor's infrastructure. "Each environment you
  deploy on Upsun Fixed is built as a set of containers."
- **Heritage.** Strong in the PHP/Drupal/Symfony and European enterprise-web markets; the product's
  shape reflects agency and CMS workflows where "spin up a copy of the client's site" is the daily
  operation.
- **Commercial status.** Proprietary and commercial.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **App** | A container declared by `.platform.app.yaml` — "you usually create one `.platform.app.yaml` file for each app container" |
| **Services** | Managed backing services (databases, caches, search) declared in `.platform/services.yaml` |
| **Routes** | The HTTP routing table, "defined in a router, which is the `.platform/routes.yaml` file in your Git repository" |
| **Project** | The repository plus its environments |
| **Environment** | A running instance of the whole project, corresponding to a Git branch |
| **`project:init`** | Generates the three default YAML files "based on your detected local stack" |

The mental model is worth stating precisely, because it is the product's whole value:

> "A new development environment can be created for each branch or pull request… When a new
> development environment is created, the production environment's data will be cloned on-the-fly,
> giving you an isolated, production-ready test environment."

**Data is part of the environment.** Almost every competitor in this corpus treats environments as
compute-plus-config and leaves data as the user's problem. Upsun clones the database. That single
decision is what makes its previews genuinely production-like, and it is the hardest part of
ephemeral environments to build.

## Feature surface

- **Authoring** — three declarative YAML files committed to the repository: app, services, routes.
- **Resource model** — app containers plus service containers, wired by relationships and exposed by
  routes.
- **Environments** — branch-per-environment with on-the-fly data cloning; environment inheritance
  from the parent branch.
- **Delivery** — push to deploy; every branch and pull request can be an environment.
- **Services** — managed databases, caches, and search, versioned in `services.yaml`.
- **Routing** — declarative HTTP routes including redirects and cache rules.
- **API/CLI** — a documented [API](https://api.upsun.com/docs/) and a CLI covering project and
  environment lifecycle.
- **Integrations** — third-party Git hosting integrations drive environment creation from branches
  and pull requests.

## Architecture

- **Control plane** — Upsun's managed service: build orchestration, environment lifecycle, routing,
  and service provisioning.
- **Data plane** — the vendor's infrastructure; environments are container sets with attached
  managed services.
- **Build model** — each environment is built from the committed configuration, producing an
  immutable image set deployed together.
- **Data cloning** — the distinguishing mechanism: parent-environment data is snapshotted into the
  child on creation.
- **State authority** — the Git repository for configuration, the platform for environment state.
  Configuration-as-code is genuine here: the three YAML files fully describe the topology.
- **Portability boundary** — **narrow and honest**. The YAML schema is Upsun's own; applications run
  on Upsun's infrastructure. Nothing about the model anticipates leaving, and the vendor does not
  claim otherwise.

## How it competes with HoBo

Upsun contests HoBo's **environment story** specifically, and does it better than HoBo does today.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `environments` | **The sharpest contest.** Branch-as-environment with cloned production data is the reference implementation of ephemeral environments |
| `authoring` | Three YAML files declaring apps, services and routes is a genuinely simple topology description |
| `app-graph` | Apps plus services plus routes is a small but complete application graph |
| `wiring` | Relationships between apps and services are declared and injected |
| `delivery` | Push-to-deploy with per-branch environments |

It does not contest provider matching, portability, or multi-cloud placement — it has none of them
and wants none of them.

## Primitive mapping

| Upsun | Nearest HoBo concept | Honest correspondence |
| ----- | -------------------- | --------------------- |
| `.platform.app.yaml` | Bindle workload node | **Partial.** Both declare a runnable unit; the Upsun file is bound to Upsun's runtime. |
| `services.yaml` | Bindle kinds for data/cache/search | **Close in shape.** Both declare a needed capability by type and version. HoBo's resolve to any provider's implementation; Upsun's resolve to Upsun's. |
| `routes.yaml` | Gateway/ingress port declaration | Close. |
| Project | Application / Bindle scope | Close. |
| Environment (branch) | Camp | **Close in role, and Upsun's is stronger in one dimension:** HoBo's Camps do not clone data. |
| Data cloning on environment creation | — | **No HoBo equivalent** (*not-present*). This is the gap. |
| Relationships | Typed wiring / `.allow()` | Partial: Upsun injects connection details; HoBo's declaration also carries authorization intent. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent, by design.** One provider means nothing to choose between. |

## Where Upsun is stronger

- **Environments include data.** Cloning production data into every branch environment is the single
  best-executed idea in this corpus's PaaS cohort, and the one most competitors avoid because it is
  hard.
- **Configuration is genuinely complete.** Three YAML files describe the entire topology — app,
  backing services, routing — which is a lower-ceremony application description than most.
- **Branch-as-environment needs no explanation.** The mental model maps onto how teams already work,
  with no new concepts to learn.
- **Mature managed services**, versioned declaratively alongside the app.
- **Long operational history** in demanding CMS/agency workloads where per-client environments are
  the norm.

## Where HoBo is stronger or intentionally different

- **Provider-abstract description** (*implemented*). An Upsun YAML file is an Upsun artifact; a
  Bindle targets whatever provider matching selects.
- **Placement is decided and recorded** (*implemented*, `match.Decided`) — Upsun has one place.
- **Portability is measured** (*implemented*, ADR-0144) — not applicable to a single-vendor PaaS,
  which is precisely the point of difference.
- **Fail-closed residency** (*implemented*, ADR-0146) versus the vendor's available regions.
- **Event-sourced control plane with replay** (*implemented*, ADR-0135).
- **Runs locally and in-browser** (*implemented*) with no vendor account.
- **Honest caveat.** On the environment lifecycle *as a user experiences it*, Upsun is ahead. HoBo's
  ephemeral Camps are designed; Upsun's branch environments with cloned data are shipped and mature.

## Adversarial critique

- **Total platform lock-in.** The YAML schema, the services, the routing model and the runtime are
  all Upsun's. There is no export path, and the configuration files are worthless outside the
  platform. This is the strongest lock-in in the cloud-application-platform cohort.
- **Data cloning is a compliance hazard.** Cloning production data into developer environments is
  exactly what data-protection regimes restrict. Sanitization is the customer's responsibility, and
  the default behaviour is the risky one.
- **Scaling model is the vendor's.** Container sizing and scaling behaviour are platform decisions;
  applications with unusual resource profiles fit awkwardly.
- **Cost scales with environments.** The feature that makes the product delightful — an environment
  per branch, each with cloned data — is also the one that makes spend grow with team activity.
- **The rename is unfinished.** Two documentation sites (`docs.upsun.com` and
  `fixed.docs.upsun.com`) describing two product generations is a real adoption friction, and makes
  it harder for customers to know which behaviour applies to them.
- **Narrow workload fit.** The model suits request/response web applications; batch, streaming,
  GPU and actor workloads are not what the platform is shaped for.
- **Single-region-per-project reality.** Multi-region topologies are not what the environment model
  expresses.

## Better-together / integration posture

- **Borrow** — **environment data cloning**, and it is one of the highest-value borrows identified in
  this corpus. A HoBo ephemeral Camp that clones (and can sanitize) upstream data would close a real
  gap in the preview-environment story. The compliance hazard above is also the design constraint:
  HoBo's residency and policy layers are exactly the mechanism that would let it clone *safely*,
  which is a differentiated version of the feature rather than a copy.
- **Benchmark** — the three-file topology declaration is the ceremony budget HoBo's authoring should
  respect.
- **Provider-target** — plausible: Upsun as a realization target for web-shaped Bindles.
- Not a displace or adopt target.

## Threats and lessons

1. **Environments are a product, not a configuration.** Upsun wins on the daily loop — branch, get a
   real environment, test against real data. HoBo's Camps are more capable and less delightful, and
   the delightful part is what buyers evaluate.
2. **Data is the hard half of environments** (*not-present* in HoBo). Every ephemeral-environment
   story that omits data is solving the easy half. This deserves its own implementation issue, and
   HoBo's residency/policy machinery makes a *safe* version of it a genuine differentiator rather
   than catch-up.
3. **Lock-in this complete is a durable business and a durable objection.** Upsun customers cannot
   leave cheaply, which is both why the company is stable and why HoBo's portability argument lands
   with exactly the buyers who have felt it.
4. **Rename hygiene matters.** Two docs sites and two product generations under one brand is a
   cautionary tale for HoBo's own alias and migration handling — the reason the corpus now enforces
   one canonical capture per product with aliases resolving to it.

## Sources

- [Upsun YAML structure](https://docs.upsun.com/learn/overview/yaml/yaml-structure.html) — the three configuration files and their roles
- [Structure](https://fixed.docs.upsun.com/learn/overview/structure.html) — containers per environment, `project:init` generation, branch environments with cloned production data
- [Add services](https://fixed.docs.upsun.com/add-services.html) — `services.yaml`
- [Define routes](https://fixed.docs.upsun.com/define-routes.html) — `routes.yaml`
- [Platform.sh / Upsun API](https://api.upsun.com/docs/) — API surface

Pricing, region availability, and the current migration path between Upsun and Upsun Fixed were not
verified in this pass and are not asserted.
