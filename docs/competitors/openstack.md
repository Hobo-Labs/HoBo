---
type: Competitive Reference
title: "OpenStack — Competitor Reference"
description: "The open-source IaaS control plane: Nova, Neutron, Cinder, Keystone and friends — a private cloud you operate yourself, and a provider target rather than a rival."
tags: [hobo, competitors]
competitor:
  slug: openstack
  name: "OpenStack"
  aliases: ["openinfra"]
  primary_category: hybrid-multicloud-enterprise
  categories: [hybrid-multicloud-enterprise, runtime-substrates]
  directness: complementary
  role: "the open-source IaaS layer under sovereign and on-premise estates — a provider target, and the corpus's clearest lesson about the cost of being a platform of platforms"
  posture: [provider-target, benchmark]
  hobo_surface: [provider-matching, runtime-portability, governance]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.openstack.org/
    - https://www.openstack.org/software/
    - https://opendev.org/openstack
---

# OpenStack — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.

## What it is

OpenStack is **an open-source infrastructure-as-a-service platform**: a set of interoperating
services that turn pools of compute, storage and networking into an API-driven cloud you operate
yourself. It is what sits underneath sovereign clouds, telco infrastructure, research computing and
a substantial share of European and public-sector private cloud.

- **Product boundary.** IaaS: virtual machines, networks, volumes, images, identity, and the APIs
  around them. It is not a PaaS and does not model applications.
- **Operating model.** Self-operated, or consumed from a public OpenStack cloud (OVH, Rackspace,
  various national providers).
- **Governance.** Open Infrastructure Foundation, multi-vendor, long-running, with a coordinated
  release cadence.
- **Why it matters to HoBo.** It is where sovereignty-constrained workloads actually run, which
  makes it the natural substrate for exactly the residency-sensitive customers HoBo's jurisdiction
  model targets.

## Core primitives and mental model

| Service | What it provides |
| ------- | ---------------- |
| **Keystone** | Identity, projects, roles — the authorization spine every other service defers to |
| **Nova** | Compute: instances, flavors, scheduling onto hypervisors |
| **Neutron** | Networking: networks, subnets, routers, security groups, floating IPs |
| **Cinder** | Block storage volumes |
| **Glance** | Images |
| **Swift** | Object storage |
| **Heat** | Orchestration — templated stacks of the above |
| **Octavia / Designate / Barbican** | Load balancing, DNS, secrets |

The mental model is **a cloud you assemble**. Each service is independently deployable with its own
API, database and agents, and a working cloud is a chosen subset wired together. That composability
is the design's strength and the direct source of its operational reputation.

## Feature surface

- Compute with flavors, availability zones, host aggregates and a filter-and-weight scheduler.
- Software-defined networking with tenant isolation, security groups and floating IPs.
- Block and object storage, images, and snapshots.
- Multi-tenancy via projects and domains, enforced through Keystone.
- Quotas per project — genuinely first-class, unlike much of this corpus.
- Heat for templated orchestration of stacks.
- Bare-metal provisioning (Ironic) and a Kubernetes integration path (Magnum, or more commonly
  cluster installers running on top).

## Architecture

- **Service-per-concern** — each project has its own API service, scheduler where relevant, message
  bus consumers and agents on compute or network nodes.
- **Shared infrastructure** — a message queue (usually RabbitMQ) and databases underpin everything,
  and they are where the operational difficulty concentrates.
- **Nova's scheduler** — filters hosts by feasibility then weighs them, which is the same
  filter-and-rank shape as Kubernetes' scheduler and as HoBo's matching, at the hypervisor level.
- **State authority** — per-service databases; there is no single cluster state.
- **Portability boundary** — the OpenStack APIs are a genuine standard with multiple independent
  implementations and public clouds, which is rarer and more valuable than it sounds. Workloads move
  between OpenStack clouds far more readily than between hyperscalers.

## How it competes with HoBo

It does not. OpenStack is a **provider target** and, for a class of customer, the only politically
acceptable one.

| Surface | Relationship |
| ------- | ------------ |
| `provider-matching` | OpenStack is a candidate target, and its own scheduler is a nested instance of the same problem |
| `runtime-portability` | A destination, not a competitor |
| `governance` | Projects, domains and quotas are a mature tenancy model worth learning from |

The relevant point for HoBo's strategy: **residency-constrained customers frequently run OpenStack**,
so a credible sovereign-cloud story requires treating it as a first-class target rather than an
afterthought.

## Primitive mapping

| OpenStack | Nearest HoBo concept | Honest correspondence |
| --------- | -------------------- | --------------------- |
| Project / domain (Keystone) | Tenant | **Close, and OpenStack's is more complete** — hierarchical domains with quotas enforced across every service. |
| Nova flavor | Compute sizing in a Bindle kind | Partial. |
| Nova scheduler (filter + weigh) | Provider matching | **Structurally the same algorithm**, one layer down: feasibility filter, then weighted ranking. |
| Neutron network / security group | Connectivity port realization | Partial. |
| Cinder / Swift | Data and object-store kinds | Partial. |
| Heat stack | Manifest realization | Partial: Heat templates are OpenStack-specific. |
| Quotas | — | **No HoBo equivalent worth the name** (*not-present*). Per-tenant resource quotas enforced at the API are a governance primitive HoBo lacks. |
| — | `PortabilityReport` | No equivalent; OpenStack's portability claim is API standardization across clouds. |

## Where OpenStack is stronger

- **It is a real open standard with multiple implementations**, which is what portability looks like
  when it works — a workload moving between two independent OpenStack clouds is genuinely routine.
- **Sovereignty.** For customers who cannot use a hyperscaler, OpenStack is frequently the only
  answer, and it has been for a decade.
- **Multi-tenancy and quotas are mature**, enforced consistently across services.
- **Bare metal and virtualization together**, including Ironic, which most of this corpus ignores.
- **Longevity and governance.** Multi-vendor, foundation-governed, still shipping coordinated
  releases after many years.

## Where HoBo is stronger or intentionally different

- **HoBo describes applications; OpenStack provides infrastructure** (*implemented*). They are
  different layers, and this section exists for contract completeness rather than to claim a contest.
- **Placement across providers** (*implemented*): OpenStack is one candidate target among several.
- **Fail-closed residency** (*implemented*, ADR-0146) — and OpenStack is precisely where those
  decisions land, which makes it a strategically important target rather than a rival.
- **Honest caveat.** HoBo has no OpenStack provider shipped today; see the
  [live provider matrix](../design/live-provider-matrix.md).

## Adversarial critique

- **Operational difficulty is the defining characteristic**, and it is why the market moved to
  managed Kubernetes and hyperscalers. Running OpenStack well requires a dedicated team, and the
  message bus and databases underneath are where outages originate.
- **Upgrades are notoriously painful.** Coordinated releases across many services with schema
  migrations have historically been a major operational event, and this reputation is a substantial
  part of why adoption plateaued.
- **The component matrix is enormous.** Dozens of projects at varying maturity, with real
  differences between what is production-grade and what is not — evaluating that is itself a
  project.
- **Distribution divergence.** Vendor distributions differ in defaults, supported services and
  versions, which erodes the API-standardization benefit in practice.
- **IaaS is the wrong altitude for most application teams.** Instances, networks and volumes are what
  the industry spent a decade trying to stop thinking about.
- **Ecosystem momentum has shifted.** New tooling targets Kubernetes and hyperscaler APIs first;
  OpenStack support is often a later addition, which affects everything from Terraform providers to
  observability agents.
- **A platform of platforms is a hard product.** OpenStack's composability means every deployment is
  different, so shared operational knowledge transfers less well than the community size suggests.

## Better-together / integration posture

- **Provider-target** — and a strategically important one: sovereign, on-premise and telco estates
  are exactly where HoBo's residency model earns its keep, and OpenStack is what runs there.
- **Benchmark** — on multi-tenancy and quotas, which are more complete than HoBo's equivalents.
- **Borrow** — **per-tenant quotas enforced at the API boundary**. HoBo has policy decisions and no
  resource quota primitive; OpenStack's is the mature reference.
- Not a displace or adopt target.

## Threats and lessons

1. **A standard with multiple independent implementations is what real portability looks like.**
   OpenStack is the corpus's only example of workloads moving routinely between independently
   operated clouds. Worth citing when explaining what HoBo means by portability.
2. **Operational cost determines adoption more than capability does.** OpenStack lost ground to
   managed services despite being technically capable — the same dynamic that makes HoBo's
   local-first, no-cluster-required posture strategically important.
3. **Quotas are a missing HoBo primitive** (*not-present*). Policy decides whether an action is
   allowed; quotas decide how much. HoBo has no answer to the second, and it belongs in its own
   implementation issue.
4. **Sovereignty is a growing requirement, not a niche.** The customers who need it are the ones who
   most need `evaluateResidency`, and they run OpenStack.

## Sources

- [docs.openstack.org](https://docs.openstack.org/) — service documentation for Nova, Neutron, Cinder, Keystone, Glance, Swift, Heat and others
- [openstack.org/software](https://www.openstack.org/software/) — project map and release information
- [opendev.org/openstack](https://opendev.org/openstack) — source repositories

Current project maturity levels, distribution differences and upgrade tooling have changed
substantially over the project's life; none is asserted with specifics here beyond the structural
observations above.
