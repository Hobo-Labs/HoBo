---
type: Competitive Reference
title: "OpenChoreo — Competitor Reference"
description: "CNCF Sandbox internal developer platform for Kubernetes: Project/Component/Environment/DataPlane abstractions realized as Cells, with a Backstage portal."
tags: [hobo, competitors]
competitor:
  slug: openchoreo
  name: "OpenChoreo"
  aliases: ["choreo-idp", "choreo idp"]
  primary_category: platform-orchestrators
  categories: [platform-orchestrators, portable-application-models, developer-portals-idps, delivery-release-gitops]
  directness: direct
  role: "open-source Kubernetes IDP with an explicit developer-intent abstraction layer and a cell-based runtime boundary"
  posture: [displace, borrow, benchmark]
  hobo_surface: [app-graph, environments, typed-contracts, delivery, governance, wiring]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://openchoreo.dev/docs/
    - https://openchoreo.dev/docs/concepts/platform-abstractions/
    - https://openchoreo.dev/docs/overview/architecture/
    - https://github.com/openchoreo/openchoreo
---

# OpenChoreo — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-19**. HoBo's side of each comparison is labelled **implemented**,
> **proof**, or **design-only**.

## What it is

OpenChoreo is an **open-source internal developer platform for Kubernetes**, a **CNCF Sandbox**
project, open-sourced by WSO2 out of its commercial Choreo product. It describes itself as "a
complete, open-source developer platform for Kubernetes, ready to use from day one, built to
integrate with your stack" ([openchoreo.dev](https://openchoreo.dev/)).

- **Product boundary.** Developer abstractions, application CI/CD, GitOps, a Backstage-powered
  developer portal, and observability — the platform layer above Kubernetes, not the cluster itself.
- **Operating model.** Self-hosted, installed into the customer's own clusters. There is no vendor
  control plane to depend on.
- **Governance and license.** CNCF Sandbox, developed in the open at
  [github.com/openchoreo/openchoreo](https://github.com/openchoreo/openchoreo). Its lineage in the
  commercial Choreo product is relevant context: the OSS project is a genuine extraction, and the
  vendor retains a commercial offering above it.
- **Kubernetes premise.** Explicit and unapologetic — every abstraction lands as Kubernetes
  resources.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Project** | The application grouping; "maps to a set of Namespaces (one per Environment) in one or more Data planes" |
| **Component** | "A deployable unit within a project, such as a web service, API, worker, or scheduled task", mapping to Deployment, Job or StatefulSet |
| **Environment** | "A stage in the software delivery lifecycle", providing "the context for deploying and running applications, defining the policies, configurations, and constraints that apply to workloads in that stage" |
| **DataPlane** | "A Kubernetes cluster where application workloads run", abstracting cluster management behind "a unified interface for deploying applications across multiple clusters regardless of their location" |
| **BuildPlane** | A separate plane for build execution (a later addition, tracked in the project's own issues) |
| **Cell** | The runtime boundary: "secure, isolated, and observable boundaries for all components belonging to a given namespace-project-environment combination", following Cell-Based Architecture |
| **Endpoints / dependencies** | The declared interfaces and connections between components |

The mental model is the strongest structural idea in this cohort: **developer intent and platform
intent are separate inputs to one translation step.** The Control Plane "takes developer intent and
platform intent expressed through high-level abstractions like components, endpoints, dependencies,
environments, pipelines, and namespaces and translates them into the underlying Kubernetes
resources", and the Data Plane is "where OpenChoreo enforces and guarantees the semantics of those
high-level abstractions, such as isolation between projects, traffic policies, and security
boundaries".

That second half matters: the abstraction is not merely a templating convenience, because the
runtime enforces the properties the abstraction promises. Cells are how "isolated" stays true.

## Feature surface

- **Authoring** — declarative Components with endpoints and dependencies; developers do not write
  Kubernetes manifests.
- **Resource model** — Project → Component → Environment, realized as namespaces per environment
  across one or more DataPlanes.
- **Environments and lifecycle** — first-class environments carrying policy, configuration and
  constraints; promotion across environments.
- **Providers/placement** — DataPlanes are the placement unit; multiple clusters "regardless of
  their location".
- **Runtime** — Cells as enforced isolation, traffic-policy and observability boundaries.
- **Delivery** — application CI/CD plus GitOps.
- **Portal** — Backstage-powered developer portal, plus a cell-diagram visualization of the
  application topology.
- **Observability** — built in, scoped by Cell.
- **Extensibility** — Kubernetes-native: CRDs and controllers.

## Architecture

- **Control plane** — OpenChoreo's controllers, running in the customer's cluster. Translate
  developer + platform intent into Kubernetes resources.
- **Data plane** — one or more registered Kubernetes clusters running the workloads, enforcing Cell
  semantics.
- **Build plane** — separated from the data plane so build workloads do not share the runtime's
  isolation domain.
- **Reconciliation** — Kubernetes controller reconciliation; the platform inherits the model rather
  than reimplementing it.
- **State authority** — Kubernetes resources (etcd) plus Git. Declarative and reconciled, but not an
  event log with replay.
- **Portability boundary** — **portable across Kubernetes clusters, and only across Kubernetes
  clusters.** A DataPlane is a cluster. Moving to a provider's managed service that is not a cluster
  is out of scope by construction.

## How it competes with HoBo

OpenChoreo is a **direct competitor with an unusually similar architecture of ideas** — abstraction
layer, intent translation, enforced runtime semantics — and a deliberately narrower substrate.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `app-graph` | Project/Component/endpoints/dependencies is a real application graph, visualized as a cell diagram |
| `environments` | Environments carry policy and constraints, as HoBo's Camps do |
| `typed-contracts` | Endpoints and dependencies are declared interfaces between components |
| `wiring` | Dependencies connect components without manifest plumbing |
| `delivery` | CI/CD plus GitOps |
| `governance` | Policy per environment, isolation per Cell |

The decisive difference is **substrate scope**. OpenChoreo abstracts *over Kubernetes*; HoBo
abstracts *over providers*, of which Kubernetes is one. For a customer who has already decided that
everything runs on Kubernetes, OpenChoreo is the better-fitting answer and free. HoBo's advantage
only exists for customers whose targets are heterogeneous — and HoBo's positioning should concede
that plainly rather than pretending the Kubernetes-only case is a weakness.

Being open source and CNCF-governed also makes it the strongest *adoption* competitor in this
category: there is no procurement conversation.

## Primitive mapping

| OpenChoreo | Nearest HoBo concept | Honest correspondence |
| ---------- | -------------------- | --------------------- |
| Project | Bindle (application) | **Close in role.** Both group an application's parts. A Bindle is provider-abstract; a Project is defined as namespaces in clusters. |
| Component | Bindle workload node | Close, with the same caveat: a Component maps to a Kubernetes workload kind, a Bindle node to an abstract capability. |
| Endpoint / dependency | BoundaryContract / typed link | **Partial.** Both declare interfaces and connections; HoBo's carry effects and resilience metadata (ADR-0136), which OpenChoreo's do not. |
| Environment | Camp | **Close.** Both carry policy and configuration for a lifecycle stage. HoBo's additionally carries residency scope (ADR-0146). |
| DataPlane | Yard / provider target | **Partial and important.** A DataPlane is always a Kubernetes cluster; a Yard groups arbitrary provider targets. |
| BuildPlane | Build machine / runner provider | Close in intent. |
| Cell | — | **No HoBo equivalent, and this is a genuine gap** (*not-present*). HoBo has no enforced runtime isolation boundary that guarantees the properties its abstractions promise. |
| Backstage portal | — | HoBo is not a portal; Backstage is an integration target. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** Placement is choosing a DataPlane, not a scored decision across heterogeneous providers. |

## Where OpenChoreo is stronger

- **The runtime enforces the abstraction.** Cells make isolation, traffic policy and observability
  boundaries real rather than conventional. Most platforms in this corpus promise properties their
  runtime does not enforce; this one enforces them.
- **Open source, CNCF Sandbox, self-hosted.** No vendor plane, no licence, no procurement.
- **Kubernetes-native extensibility.** CRDs and controllers mean the ecosystem composes without a
  plugin API.
- **Portal included.** Backstage integration and cell-diagram visualization ship with it.
- **Coherent plane separation.** Control / Data / Build planes are cleanly separated, which most
  competitors muddle.
- **Battle-tested lineage.** Extracted from a commercial product that ran real customer workloads.

## Where HoBo is stronger or intentionally different

- **Substrate breadth** (*implemented*). HoBo targets providers, not only clusters. This is the
  entire difference and it cuts both ways.
- **Portability is scored** (*implemented*). `PortabilityReport` plus thin-adapter impedance limits
  (ADR-0144). OpenChoreo needs none of this because its targets are homogeneous — which is a
  legitimate design choice, not an oversight.
- **Event-sourced control plane with replay** (*implemented*, ADR-0135) versus etcd + Git.
- **Runs without Kubernetes at all** (*implemented*). `@hobo/runtime-local` and
  `@hobo/runtime-browser` — a developer needs no cluster.
- **Fail-closed residency** (*implemented*, ADR-0146); DataPlane selection has no jurisdiction model.
- **Contract effects and resilience profiles** (*implemented*, ADR-0136) on the same boundary
  OpenChoreo types with endpoints.
- **Honest caveat.** OpenChoreo ships a working IDP with a portal and enforced isolation today.
  HoBo's provider breadth is real in design and partial in `packages/` (see the
  [live provider matrix](../design/live-provider-matrix.md)).

## Adversarial critique

- **Kubernetes is a hard floor.** Every abstraction bottoms out in cluster resources. Teams on
  serverless, edge, or managed-service architectures are simply not addressable, and the "regardless
  of their location" phrasing quietly means "regardless of which cluster".
- **Cell-based architecture is opinionated.** It is a good opinion, but it imposes a topology; teams
  whose services do not partition cleanly along project-environment lines inherit friction.
- **Sandbox maturity.** CNCF Sandbox is the earliest tier. API stability, upgrade paths and
  operational track record outside WSO2's orbit are unproven.
- **Vendor gravity.** The project's direction is substantially set by one company with a commercial
  product above it. That is a normal and often healthy arrangement, but the OSS/commercial boundary
  is a thing adopters must evaluate.
- **Operational surface.** Control plane, data planes, build plane, portal and observability stack
  are a lot of moving parts to run before the first application deploys — the usual cost of
  "complete platform" claims.
- **Abstraction leakage under debugging.** When something breaks, operators are debugging generated
  Kubernetes resources, and the mapping back to Components and Cells has to be excellent or the
  abstraction becomes an obstacle. The docs do not evidence how well that holds.
- **No decision record.** Placement is configuration, not a recorded, explainable decision.

## Better-together / integration posture

- **Displace** in positioning — for Kubernetes-only estates OpenChoreo is a genuine substitute, and
  a free one.
- **Borrow**, and this is the most valuable borrow in the cohort: **the Cell**. An enforced runtime
  boundary that guarantees the semantics of the abstraction — isolation, traffic policy,
  observability scope — is exactly what would make HoBo's Bindle claims verifiable at runtime rather
  than at deploy time. Also worth borrowing: the explicit *developer intent vs platform intent*
  split as a documented authoring model.
- **Benchmark** on time-to-first-deploy and on portal integration.
- Plausibly an **integrate** target too: HoBo could treat an OpenChoreo installation as a
  Kubernetes-flavoured provider target rather than competing inside the cluster.

## Threats and lessons

1. **Free, open, CNCF-governed, and good is a hard competitor.** For any prospect standardized on
   Kubernetes, HoBo must justify itself against something with no licence cost and no vendor risk.
   The justification is heterogeneity — and only heterogeneity. Positioning should say so.
2. **Cells are the idea to steal** (*not-present* in HoBo). Runtime enforcement of the properties an
   abstraction promises is the difference between a manifest and a guarantee. This deserves its own
   implementation issue: what would it mean for a HoBo Camp to *enforce* isolation rather than
   describe it?
3. **Developer intent vs platform intent as separate inputs** is a cleaner articulation than HoBo's
   current docs manage, and echoes the same lesson from Facets. Two independent competitors reaching
   the same framing is a signal worth acting on.
4. **A visual topology view keeps recurring.** Cell diagrams here, the canvas in Massdriver. Third
   independent occurrence of the same missing HoBo surface.

Product gaps recorded here (enforced runtime boundary; browsable topology view) belong in their own
implementation issues, per the research contract.

## Sources

- [What is OpenChoreo](https://openchoreo.dev/docs/) — positioning, CNCF Sandbox status, feature scope
- [Platform abstractions](https://openchoreo.dev/docs/concepts/platform-abstractions/) — Project, Component, Environment, DataPlane definitions
- [Architecture](https://openchoreo.dev/docs/overview/architecture/) — control/data plane split, intent translation, Cells as runtime boundaries
- [openchoreo/openchoreo](https://github.com/openchoreo/openchoreo) — source, and [BuildPlane abstraction issue #221](https://github.com/openchoreo/openchoreo/issues/221)
- [choreo-concepts.md](https://github.com/openchoreo/openchoreo/blob/main/docs/choreo-concepts.md) — namespace/project/environment mapping

API stability guarantees, upgrade paths, and the OSS/commercial boundary with WSO2's Choreo were not
verified in this pass and are not asserted.
