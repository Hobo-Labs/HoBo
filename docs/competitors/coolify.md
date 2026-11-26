---
type: Competitive Reference
title: "Coolify — Competitor Reference"
description: "Open-source self-hosted PaaS: point it at your own servers and deploy applications, databases and 280+ services with SSL, backups and Git integration."
tags: [hobo, competitors]
competitor:
  slug: coolify
  name: "Coolify"
  aliases: ["coolify.io"]
  primary_category: self-hosted-paas
  categories: [self-hosted-paas, cloud-application-platforms]
  directness: overlapping
  role: "the leading open-source self-hosted PaaS — the clearest demonstration that the Heroku experience can be delivered on a rented VPS with no vendor"
  posture: [benchmark, borrow]
  hobo_surface: [authoring, delivery, environments, provider-matching]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://coolify.io/docs
    - https://coolify.io/
    - https://coolify.io/self-hosted
    - https://coolify.io/services
---

# Coolify — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.

## What it is

Coolify is **an open-source, self-hostable PaaS**: "an open-source Platform as a Service (PaaS) for
self-hosting databases, services, and applications with free SSL, backups, and Git integration",
letting you "deploy apps, databases & 280+ services to your server", where "self-hosted is free
forever" ([coolify.io](https://coolify.io/)).

Its significance to this corpus is that it makes the Heroku experience available with **no vendor at
all** — install it on a VPS you rent, connect a Git repository, and get push-to-deploy with TLS.

- **Product boundary.** Deploy and operate applications, databases and packaged services on servers
  you control.
- **Operating model.** Self-hosted and free, with a paid cloud option for people who would rather
  not run the controller themselves.
- **Commercial status.** Open source, with a hosted offering funding development.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Server** | A machine Coolify manages over SSH — a VPS, a bare-metal box, or a home server |
| **Project / environment** | The grouping and lifecycle scoping for resources |
| **Application** | A deployment from a Git repository, Dockerfile or Compose file |
| **Database** | A managed database instance with backups |
| **Service** | One of the many one-click packaged applications (the "280+ services") |
| **Destination** | Where a resource runs — a Docker network on a chosen server |

The mental model is **your servers, someone else's control plane software**. Coolify holds the
configuration and orchestrates over SSH and Docker; the machines and the data stay the operator's.

## Feature surface

- Git-driven deploys with build packs, Dockerfiles or Compose files.
- Automatic TLS certificates and reverse-proxy configuration.
- Managed databases with scheduled backups.
- A large catalog of one-click self-hostable services.
- Multi-server management from one controller.
- Preview deployments per pull request.
- Webhooks, environment variables, and scheduled tasks.

## Architecture

- **Controller** — the Coolify application itself, running on one machine, holding configuration and
  driving everything else.
- **Execution** — SSH to managed servers, Docker for workloads, a reverse proxy (Traefik or Caddy)
  for ingress and TLS.
- **State authority** — the controller's own database. This is the architecture's weak point:
  the controller is a single point of failure and its backup is the operator's responsibility.
- **Portability boundary** — what runs is ordinary Docker on ordinary servers, so the *workloads*
  survive Coolify's absence even though the configuration does not. That is a materially better exit
  story than any hosted PaaS.

## How it competes with HoBo

Coolify contests HoBo's **self-host and small-team story** directly, and nothing else.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | Almost none required — connect a repository and go |
| `delivery` | Push to deploy with TLS and previews |
| `environments` | Projects and environments per server |
| `provider-matching` | Choosing which server a resource lands on, manually |

A developer who wants "Heroku on my own VPS" has an excellent free answer today, and it is not HoBo.

## Primitive mapping

| Coolify | Nearest HoBo concept | Honest correspondence |
| ------- | -------------------- | --------------------- |
| Server | Node / Camp substrate | Close in role; Coolify's is always a Docker host reached by SSH. |
| Application | Bindle workload node | Partial — a container deployment rather than a capability requirement. |
| Database / service | Bindle kind realization | **Partial, and instructive.** Coolify's catalog is concrete packaged software; HoBo's kinds abstract over managed services and self-hosted alternatives alike. |
| Project / environment | Camp | Close. |
| Destination | Placement | Manual selection rather than a scored decision. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** |

## Where Coolify is stronger

- **Free, open, and genuinely complete for its scope.** TLS, backups, previews and a service catalog
  without a vendor relationship is a strong package.
- **The 280+ service catalog** is the ecosystem asset: one-click Postgres, Redis, Umami, Plausible,
  n8n and hundreds more make the platform immediately useful.
- **Your servers, your data**, with workloads that are ordinary Docker containers.
- **Time to first deploy is minutes**, which is the metric this category is judged on.
- **Active community and rapid development.**

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Provider-abstract description** (*implemented*). Coolify deploys containers to servers; a Bindle
  can target managed cloud services, wasm hosts or local runtimes.
- **Placement is decided and recorded** (*implemented*, `match.Decided`); Coolify's is a dropdown.
- **Policy, residency and portability scoring** (*implemented*, ADR-0144/0146) have no Coolify
  analogs, and for its audience they are not missed.
- **Event-sourced control plane with replay** (*implemented*, ADR-0135) versus a controller database
  the operator must remember to back up.
- **Honest caveat.** For a developer with one VPS and one application, Coolify is a better answer
  than HoBo today and probably tomorrow. That is a legitimate segment boundary, not a failure.

## Adversarial critique

- **The controller is a single point of failure**, and its own backup is the operator's problem — an
  uncomfortable property for a tool whose value is operational simplicity.
- **SSH-and-Docker orchestration has a ceiling.** It works well for a handful of servers and does not
  become a scheduler; there is no rescheduling, bin-packing or failure recovery worth the name.
- **The service catalog is a supply chain.** Hundreds of one-click applications are hundreds of
  images, defaults and update paths the operator inherits.
- **Backups are configured, not verified.** Scheduled backups without tested restores are the classic
  self-hosting failure, and the ease of enabling them makes the gap easy to miss.
- **Multi-tenancy is not the model.** Coolify assumes an operator, not a platform team serving other
  teams with isolation requirements.
- **No abstraction over managed services.** Everything runs as a container on your machine, which is
  the point and also means no path to a managed Postgres when the self-hosted one stops being
  appropriate.
- **Rapid development brings churn**, and upgrade friction is a recurring theme for self-hosted
  controllers.

## Better-together / integration posture

- **Benchmark**, and seriously: Coolify defines the floor for what "self-hosted platform" costs in
  effort. HoBo's local and single-server story is measured against this whether or not it wants to
  be.
- **Borrow** — **the one-click service catalog as an adoption mechanism**. A catalog of ready-to-run
  capabilities is a better on-ramp than documentation, and it is the same distribution lesson
  Railway's templates teach.
- **Provider-target** — a Coolify-managed server is a plausible Camp substrate.
- Not an adopt or displace target.

## Threats and lessons

1. **The self-hosted PaaS problem is solved for small estates, for free.** HoBo's argument in this
   segment cannot be "you can self-host" — it has to be what happens when one server becomes several
   providers.
2. **Catalogs drive adoption.** Third corpus occurrence after Railway templates and Heroku add-ons.
   HoBo's Resource/App Packs should be positioned and merchandised the same way.
3. **A controller with a single database is the common weak point** across this whole category, and
   HoBo's event-sourced, replayable store is a real answer worth stating in these terms.
4. **Segment honesty matters.** Claiming to beat Coolify at its own job would be false; the useful
   claim is that HoBo covers the case Coolify structurally cannot.

## Sources

- [Coolify docs](https://coolify.io/docs) — servers, applications, databases, services, deployments
- [coolify.io](https://coolify.io/) and [self-hosted](https://coolify.io/self-hosted) — positioning, free self-hosting, service count
- [Services](https://coolify.io/services) — the one-click catalog
- [Pricing](https://coolify.io/pricing) — the hosted option

Exact service-catalog size changes over time; the "280+" figure is the vendor's own. Upgrade
behaviour and multi-server limits were not verified in this pass and are not asserted.
