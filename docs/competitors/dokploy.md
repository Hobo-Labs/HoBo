---
type: Competitive Reference
title: "Dokploy — Competitor Reference"
description: "Self-hosted deployment platform in the Coolify mould: applications, databases, Compose stacks and multi-server management from one controller."
tags: [hobo, competitors]
competitor:
  slug: dokploy
  name: "Dokploy"
  aliases: ["dokploy.com"]
  primary_category: self-hosted-paas
  categories: [self-hosted-paas]
  directness: adjacent
  role: "a younger self-hosted PaaS in a crowding category — evidence of how low the barrier to entry has become"
  posture: [benchmark]
  hobo_surface: [delivery, environments]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.dokploy.com/docs/core/installation
    - https://docs.dokploy.com/docs/core/comparison
---

# Dokploy — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**. Dokploy publishes its own comparison against alternatives; per the
> contract that page is treated as a vendor claim and is not used as evidence about rivals.

## What it is

Dokploy is a **self-hosted deployment platform** in the same shape as [Coolify](coolify.md): install
a controller on a server, connect Git repositories, deploy applications and databases with TLS and
backups. It "can be set up on your server within minutes with an easy-to-follow installation guide"
([installation](https://docs.dokploy.com/docs/core/installation)).

Its interest to this corpus is categorical rather than individual: the existence of several credible
open-source self-hosted PaaS products, launched within a few years of each other, shows how cheap
this capability has become to build.

- **Product boundary.** Deploy and operate applications, databases and Compose stacks on your own
  servers.
- **Operating model.** Self-hosted and open source.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Server** | A managed machine |
| **Project** | The grouping for related resources |
| **Application** | A deployment from Git, Dockerfile, Nixpacks or Compose |
| **Database** | A managed datastore instance with backups |
| **Compose stack** | A Docker Compose file deployed and managed as a unit |
| **Domain** | Ingress with automatic TLS |

The mental model matches the category: **a controller managing Docker on your servers**, with the
one notable emphasis being first-class Docker Compose support, which lowers the on-ramp for teams
who already have a Compose file.

## Feature surface

- Deploys from Git, Dockerfile, Nixpacks or Compose.
- Managed databases with scheduled backups.
- Automatic TLS and domain management.
- Multi-server management from one controller.
- Templates for common self-hosted applications.
- API and CLI access.

## Architecture

- **Controller** — the Dokploy server holding configuration and orchestrating over SSH and Docker.
- **Execution** — Docker containers with Traefik for ingress.
- **State authority** — the controller's database, with the same single-point-of-failure
  characteristic as its peers.
- **Portability boundary** — Compose files and Docker images are ordinary, so workloads survive the
  platform; the configuration does not.

## Where Dokploy is stronger

- **First-class Compose support** is a genuine on-ramp advantage — the same
  meet-the-developer-where-they-are lesson as Lagoon, in a much simpler product.
- **Fast setup** and a small conceptual surface.
- **Open source** with an active development pace.
- **Multi-server from the start**, rather than as an afterthought.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | Git and Compose deploys with TLS |
| `environments` | Projects across managed servers |

No application model, no placement decision, no policy.

## Primitive mapping

| Dokploy | Nearest HoBo concept | Honest correspondence |
| ------- | -------------------- | --------------------- |
| Server | Node / Camp substrate | Close in role. |
| Application | Bindle workload node | Partial. |
| Compose stack | Imported topology | **The interesting one** — accepting the developer's existing Compose file is the same on-ramp lesson Lagoon teaches. |
| Database | Bindle kind realization | Partial: a container, not an abstracted capability. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** |

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Provider-abstract description and scored placement** (*implemented*); Dokploy deploys containers
  to servers you name.
- **Policy, residency and replay** (*implemented*, ADR-0135/0146) have no analog here.
- **Honest caveat.** For the segment Dokploy serves, HoBo's machinery is overhead; the comparison is
  only meaningful once targets are heterogeneous.

## Adversarial critique

- **A crowded, substitutable category.** Coolify, Dokploy, CapRover, Dokku and others do
  substantially the same thing; differentiation is UI, catalog and momentum rather than architecture.
- **Single controller, single database** — the same failure mode as its peers, with the operator
  responsible for its backup.
- **Younger project** means less operational history than Dokku or Coolify, which matters most in
  exactly this self-hosted segment.
- **SSH-and-Docker orchestration ceiling** applies here as everywhere in this cohort: no scheduling,
  no rescheduling, no bin-packing.
- **Templates are a supply chain**, as in every catalog-bearing product here.
- **Comparison-page marketing** is a category signal rather than evidence.

## Better-together / integration posture

- **Benchmark** only, and mainly on the Compose on-ramp.
- Not an adopt, borrow, provider, integrate or displace target. This capture exists to place the
  category's shape accurately rather than to differentiate one entrant from another.

## Threats and lessons

1. **The self-hosted PaaS category has a very low barrier to entry**, which means HoBo will never
   win this segment on features — only on covering the case where one server becomes several
   providers.
2. **Compose is the on-ramp format**, and this is now the fifth corpus occurrence of the
   import-what-exists finding (after Lagoon, Massdriver, NetScaler and Rancher Fleet).
3. **Category crowding predicts consolidation.** Most of these products will not persist, which is
   itself a reason self-hosters weight longevity heavily.

## Sources

- [Dokploy installation](https://docs.dokploy.com/docs/core/installation) — setup and architecture
- [Dokploy comparison](https://docs.dokploy.com/docs/core/comparison) — vendor's own category framing (claims, not evidence)

Feature depth, backup verification behaviour and multi-server limits were not verified in this pass
and are not asserted.
