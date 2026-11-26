---
type: Technology Reference
title: "Cloud Foundry / Pivotal Cloud Foundry (PCF)"
description: "Cloud Foundry is the original **opinionated, open-source application Platform-as-a-Service (PaaS)**: you hand it source code, it builds and runs your app, and it manages \"all layer"
tags: [hobo, technologies]
---

# Cloud Foundry / Pivotal Cloud Foundry (PCF)

> **Technology** · opinionated application PaaS · Source: [cloudfoundry.org](https://www.cloudfoundry.org/) · [Tanzu Platform for Cloud Foundry docs (Broadcom)](https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/elastic-application-runtime/10-2/eart/concepts-overview.html) · [Open Service Broker API](https://www.openservicebrokerapi.org/). Excerpts quoted for analysis (fair use).

## What it is
Cloud Foundry is the original **opinionated, open-source application Platform-as-a-Service (PaaS)**: you hand it source code, it builds and runs your app, and it manages "all layers except for applications and data, which remain the user's responsibility." Its defining promise is **`cf push`** — one command from source to a running, routable, scaled, log-aggregated app, with **zero changes to your code**.

It began as a VMware project (2011), became **Pivotal Cloud Foundry (PCF)** — Pivotal's commercial distribution — then returned to VMware as **VMware Tanzu Application Service (TAS)**, and is now **Tanzu Platform for Cloud Foundry under Broadcom**. The open-source core is governed by the **Cloud Foundry Foundation** (under the Linux Foundation). It influenced an entire generation of PaaS thinking (Heroku-style developer experience, the **buildpack** concept later standardized as **Cloud Native Buildpacks** in CNCF).

## Key features
- **`cf push`** — the developer entry point. Reads an optional `manifest.yml` (instances, memory, routes, env, services to bind) and pushes source (or a prebuilt artifact) to the platform.
- **Buildpacks** — "contain all languages, libraries, and services that the app uses." Cloud Foundry runs **detection** to auto-pick a buildpack (or you specify `-b`); buildpacks turn source into a runnable artifact without a hand-written Dockerfile. Standard buildpacks ship for Java, Node, Go, Python, Ruby, .NET, PHP, etc.
- **Staging → droplets** — the **Cloud Controller** stages an app by "combining the stack, buildpack, and source code into a **droplet** that the VM can unpack, compile, and run." The droplet is the **immutable, portable run-unit** distributed across hosts. (The **stack** is the base root filesystem, e.g. `cflinuxfs`.)
- **Diego runtime** — the container orchestration layer that **places and supervises app instances**. Diego uses an **auction-based scheduler** to distribute instances across **Diego Cells** (the VMs that run containers), tracks desired vs. actual state (the **BBS**, Bulletin Board System), and **self-heals** — restarting/replacing instances to maintain the desired count through failures and demand changes.
- **Routing (Gorouter)** — "routes incoming traffic from the world to the VMs that are running the apps," typically behind a customer load balancer; supports mapping multiple **routes**/domains to apps and round-robins across instances.
- **Services & marketplace + service brokers** — apps consume backing services (databases, queues, caches, SaaS) from a **marketplace** of **service offerings** and **plans**. A **Service Broker** "advertises a catalog of service offerings and service plans" and handles **provision / bind / unbind / deprovision** — the protocol is the **Open Service Broker API (OSBAPI)**, which originated here and is now a cross-platform standard (also used by Kubernetes). Binding injects credentials/connection info into the app's environment.
- **Orgs & spaces** — the multi-tenancy/RBAC model. An **org** groups users, quotas, and domains; a **space** is an environment within an org (e.g. `dev`/`staging`/`prod`) holding apps + service instances. **UAA** (User Account and Authentication) issues tokens and enforces roles (admin / developer / auditor) scoped to orgs and spaces.
- **Operations** — built-in **log aggregation** (Loggregator), metrics, health checks, rolling restarts, and horizontal scaling (`cf scale`); the platform itself is deployed/managed by **BOSH** across IaaS (vSphere/AWS/Azure/GCP).

## Relevance to HoBo
Cloud Foundry is HoBo's **clearest lineage and a sharp positioning foil** ([Plan 0](../design/vision.md#plan-00), [Plan 17](../design/vision.md#plan-17)). The "push your code, the platform does the rest" ideal is exactly what HoBo's `hobo deploy` ([Plan 7](../design/developer-experience.md#plan-07)) inherits; the differences are precisely HoBo's thesis. Concept-for-concept:

| Cloud Foundry | HoBo analog |
|---|---|
| `cf push` | `hobo deploy` (push-to-deploy from a TS app description) |
| Buildpacks → droplet | **BuildProvider** adapters producing images/rootfs/**wasm components** ([Plan 4](../design/control-plane.md#plan-04)); CNCF Buildpacks usable behind it |
| Diego (cells, auction, self-heal) | the **durable runtime a Camp supplies** + reliability/drift loop ([Plan 2 §Layer 1](../design/sdk-api.md#plan-02), [Plan 5](../design/reliability-observability-cost.md#plan-05)) |
| Service brokers + marketplace (OSBAPI) | **Providers + Registry** + the AI **Forge** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)); `.allow()`-scoped, capability-negotiated bindings ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) |
| Orgs / spaces (UAA roles) | **Tenant / Camp** + Identity (SVIDs, scoped tokens) ([Plan 12](../design/security-networking.md#plan-12), [Plan 6](../design/ai-native-agent-auth.md#plan-06)) |
| Gorouter / routes | multi-cloud ingress + custom domains ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)) |

**What HoBo keeps.** The *developer-experience verdict* of Cloud Foundry: one command from code to a running, routed, scaled, observable app; an opinionated default path; buildpack-style "no Dockerfile required"; a service-binding model where credentials are injected rather than hand-wired; and an org/space-like tenancy boundary. HoBo's "agnostic path is the default and the shortest" tenet ([Plan 2](../design/sdk-api.md#plan-02)) is the same instinct as `cf push`.

**What HoBo changes — deliberately.** Cloud Foundry is **a single, self-contained runtime you run** (Diego on BOSH-managed VMs, one platform per install); its abstraction stops at "run my app" and it is *not* cloud-agnostic in the sense that matters — you run *Cloud Foundry itself* somewhere. HoBo is instead a **cloud-agnostic control plane** that maps one app description onto *any mix of real providers* (it is "not a single PaaS, not just IaC, and not Kubernetes-only," [Plan 17](../design/vision.md#plan-17)). Concretely HoBo diverges by being:
- **Cloud-agnostic by composition** — a Camp can target AWS/Azure/GCP/Cloudflare/Fly/K8s **or** a private OpenStack ([`openstack.md`](./openstack.md)); multi-region on one provider is several Camps under one Yard, and multi-cloud is several Yards under a Junction ([ADR-0026](../design/adr/01-architecture-core.md#adr-0026)). Cloud Foundry has one runtime substrate.
- **Infrastructure-from-Code (IfC), not just app-hosting** — HoBo provisions *infrastructure* (DBs, buckets, queues) by matching Resource Definitions ([Plan 25](../design/platform-engineering.md#plan-25)), where Cloud Foundry's services are pre-existing broker offerings you bind to.
- **Event-sourced & replayable** — deploys, workflows, actor state, and token issuance are events in an append-only log ([Plan 0](../design/vision.md#plan-00), [Plan 11](../design/data-plane.md#plan-11)), giving audit/time-travel that Cloud Foundry doesn't model.
- **AI-native** — agents are first-class authenticated principals, and providers/implementations can be **AI-generated via the Forge** ([Plan 6](../design/ai-native-agent-auth.md#plan-06), [Plan 23](../design/generated-stack.md#plan-23)), versus Cloud Foundry's human-authored buildpacks/brokers.

**Reusable ideas worth importing.** OSBAPI is a proven service-binding contract and a candidate **optional provider surface** behind HoBo's provider/Registry layer (the same "speak existing standards at the boundary" stance applied to brokers). Buildpacks (via **CNCF Cloud Native Buildpacks**) are a ready-made BuildProvider implementation for the no-Dockerfile path. The org/space → tenant/Camp mapping validates HoBo's tenancy nesting. Net: HoBo treats Cloud Foundry as the **proof that push-to-deploy works**, then removes its single-runtime ceiling.

## Sources
- Cloud Foundry — https://www.cloudfoundry.org/
- Tanzu Platform for Cloud Foundry — Concepts Overview (Broadcom) — https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/elastic-application-runtime/10-2/eart/concepts-overview.html
- `cf push` — https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/elastic-application-runtime/6-0/eart/deploy-apps-deploy-app.html
- Buildpacks in Cloud Foundry — https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/elastic-application-runtime/6-0/eart/understand-buildpacks.html
- Cloud Foundry Services / Service Brokers — https://techdocs.broadcom.com/us/en/vmware-tanzu/platform/elastic-application-runtime/6-0/eart/docs-services-overview.html
- Open Service Broker API — https://www.openservicebrokerapi.org/ · Cloud Native Buildpacks — https://buildpacks.io/
