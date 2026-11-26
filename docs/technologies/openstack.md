---
type: Technology Reference
title: "OpenStack"
description: "OpenStack is a **free, open-source cloud platform, deployed mostly as Infrastructure-as-a-Service (IaaS)** in private and public clouds, where \"virtual servers and other resources "
tags: [hobo, technologies]
---

# OpenStack

> **Technology** · open-source IaaS cloud platform · Source: [openstack.org](https://www.openstack.org/) · [docs.openstack.org](https://docs.openstack.org/) · [OpenStack (Wikipedia)](https://en.wikipedia.org/wiki/OpenStack). Excerpts quoted for analysis (fair use).

## What it is
OpenStack is a **free, open-source cloud platform, deployed mostly as Infrastructure-as-a-Service (IaaS)** in private and public clouds, where "virtual servers and other resources are made available to users." It is a **modular collection of interrelated services** that control pools of compute, storage, and networking across a data center, manageable via a web dashboard, CLIs, or REST APIs.

Started in 2010 as a joint Rackspace/NASA project, it is now governed by the **Open Infrastructure Foundation (OpenInfra Foundation)** — renamed from the OpenStack Foundation in 2021, and as of 2025 operating under the Linux Foundation — with an elected **Technical Committee** overseeing technical direction. Releases follow a **time-based ~6-month cadence** with alphabetical geographic codenames (… Antelope, Bobcat, Caracal, Dalmatian, Epoxy …). OpenStack is the dominant open standard for **building your own cloud** on commodity hardware.

## Key features
Core services (each is a separate project with its own REST API and codename):

- **Nova (Compute)** — provisions and manages **virtual machines** (and bare-metal via Ironic); the compute scheduler places instances on hypervisors.
- **Neutron (Networking)** — **networking-as-a-service**: virtual networks, subnets, ports, routers, floating IPs, security groups, plus advanced services (LBaaS/FWaaS/VPNaaS) and SDN/OpenFlow backends.
- **Cinder (Block Storage)** — persistent **block volumes** attached/detached to instances; snapshots; pluggable storage backends.
- **Swift (Object Storage)** — distributed, eventually-consistent, highly durable **object/blob store** (an S3-like surface) for unstructured data.
- **Keystone (Identity)** — **authentication, authorization, multi-tenant (project) management, and the service catalog**; supports tokens, LDAP/federation, and AWS-style logins. It is the entry point clients hit first.
- **Glance (Image)** — registry of **VM images** and metadata; discover/register/retrieve boot images.
- **Heat (Orchestration)** — **template-driven orchestration** of composite stacks (HOT templates), with a **CloudFormation-compatible** query API.
- **Horizon (Dashboard)** — the web UI over the core services.
- Plus a large ecosystem: **Ironic** (bare metal), **Octavia** (load balancing), **Magnum** (container clusters), **Designate** (DNS), **Barbican** (secrets/KMS), **Placement**, **Ceilometer/Telemetry**, and 30+ others per release.

API model:
- **Everything is a versioned REST API**, authenticated by a **Keystone token** (`X-Auth-Token`); after auth, Keystone returns a **service catalog** of endpoints, so clients discover where each service lives.
- A **multi-tenant model** of *domains → projects (tenants) → users/roles*; quotas and RBAC are enforced per project.
- Many services intentionally offer **AWS-compatible surfaces** (Swift↔S3, Heat↔CloudFormation), easing migration.

Private-cloud usage: OpenStack is most commonly used to run **on-prem / private / sovereign clouds** — via vendor distributions (Red Hat OpenStack Platform, Canonical Charmed OpenStack, Mirantis), turnkey appliances, or hosted private cloud. It gives organizations cloud-style self-service and APIs **without dependence on a public hyperscaler**, which is its core appeal for regulated, cost-sensitive, and data-residency-bound workloads.

## Relevance to HoBo
OpenStack is a natural **HoBo provider** and **Camp target** — the private-cloud counterpart to the public hyperscalers HoBo already targets. In HoBo's ports/adapters model ([Plan 4](../design/control-plane.md#plan-04)), a `CloudProvider` implements capability ports (WIT interfaces: compute, network, `wasi:blobstore`, `hobo:data`, etc.) for a backend; a **Camp** is a provider-specific deployment target on one provider/cloud ([ADR-0026](../design/adr/01-architecture-core.md#adr-0026)). An **`provider-openstack`** adapter would make any private OpenStack cloud a first-class Camp.

**Service → port mapping** (the integration is unusually clean because OpenStack's services are already capability-shaped):

| OpenStack service | HoBo capability port |
|---|---|
| **Nova / Ironic** | `compute` (VMs / bare metal) |
| **Neutron** | `network` (vnets, subnets, routers, security groups) |
| **Cinder** | `volume` / block storage |
| **Swift** | `objectStore` (`wasi:blobstore`) |
| **Glance** | image source for the **BuildProvider** rootfs/VM images ([Plan 4](../design/control-plane.md#plan-04)) |
| **Keystone** | identity/token brokering — maps onto HoBo's Identity + token broker ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) |
| **Heat** | a realization **Driver** (template driver, [Plan 25](../design/platform-engineering.md#plan-25)) for the `IacProvider` |

**The strategic payoff is sovereign / air-gapped deployment.** OpenStack is the leading way to stand up a cloud *inside a boundary with zero egress*, which is exactly HoBo's air-gapped / sovereign mode ([ADR-0036](../design/adr/07-portability-extensibility.md#adr-0036)). A self-hosted Yard + Executors deploying onto an in-boundary OpenStack cloud gives the full HoBo model (deploy/match/migrate/route) **on-prem with no public-cloud dependency** — and Keystone's in-boundary identity dovetails with HoBo's internal CA / in-boundary KMS posture ([ADR-0027](../design/adr/02-identity-security.md#adr-0027)). Because OpenStack exposes AWS-compatible surfaces (Swift↔S3, Heat↔CloudFormation), much of an existing AWS-targeted adapter's IaC logic could be reused.

**Where it fits HoBo's "agnostic by default" bet.** The same Bindle that deploys to `prod-aws` should resolve to OpenStack infra purely via **context-matching** ([Plan 25](../design/platform-engineering.md#plan-25)) when an `envType`/region/tenant points at an OpenStack Camp — no app changes. Realization can go through **Heat (native)** or through **OpenTofu/Pulumi/Crossplane** providers that already speak OpenStack, so the `IacProvider` choice is just another Driver. The main caveats: OpenStack's surface is large and operator-heavy (the *running* of OpenStack is out of HoBo's scope — HoBo consumes its APIs, it doesn't deploy OpenStack itself), capability negotiation must handle that not every OpenStack deployment enables every project (Swift/Octavia/Magnum may be absent → `Capability.satisfies` returns `partial`), and durable-runtime backends still come from the Camp's runtime ports independently of the infra provider ([Plan 2 §Layer 1](../design/sdk-api.md#plan-02)).

## Sources
- OpenStack — https://www.openstack.org/
- OpenStack documentation — https://docs.openstack.org/
- OpenStack (Wikipedia) — https://en.wikipedia.org/wiki/OpenStack
- "List of OpenStack Core Services Explained" — https://computingforgeeks.com/openstack-core-services-explained/
- Red Hat OpenStack Platform — Architecture Guide, Components — https://docs.redhat.com/en/documentation/red_hat_openstack_platform/
