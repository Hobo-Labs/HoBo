---
type: Competitive Reference
title: "CapRover — Competitor Reference"
description: "Self-hosted PaaS built on Docker Swarm: one-click apps, automatic TLS, and a web UI over a real orchestrator."
tags: [hobo, competitors]
competitor:
  slug: caprover
  name: "CapRover"
  aliases: ["captainduckduck"]
  primary_category: self-hosted-paas
  categories: [self-hosted-paas]
  directness: adjacent
  role: "the self-hosted PaaS that kept a real orchestrator underneath — and inherited the fate of the orchestrator it chose"
  posture: [benchmark]
  hobo_surface: [delivery, environments, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://caprover.com/docs/
    - https://github.com/caprover/caprover
---

# CapRover — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.

## What it is

CapRover is a **self-hosted PaaS built on Docker Swarm**: a web UI and CLI over Swarm services, with
one-click application templates, automatic TLS via Let's Encrypt, and nginx for ingress.

Its distinguishing decision — and the reason it is worth capturing separately from Coolify and
Dokploy — is that it kept **a real orchestrator underneath**. Swarm gives it service definitions,
replicas, rolling updates and multi-node scheduling that SSH-loop competitors do not have.

- **Product boundary.** Deploy and operate containerized applications on a Swarm cluster you own.
- **Operating model.** Self-hosted, single node or multi-node Swarm.
- **Commercial status.** Open source (Apache-2.0).

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **App** | A Swarm service with an image, environment, persistent directories and instance count |
| **One-click app** | A templated deployment of a common application |
| **Captain definition** | The build description committed with the source |
| **Node** | A Swarm node, manager or worker |
| **nginx / Let's Encrypt** | Ingress and automatic certificates |

The mental model is **a friendly face on Swarm**: the UI creates services, Swarm schedules and
maintains them, and CapRover configures ingress and certificates around them.

## Feature surface

- Deploy from Git, tarball, Dockerfile or image.
- One-click app templates for common software.
- Automatic TLS and custom domains.
- Multi-node Swarm clusters with real scheduling and replicas.
- Persistent volumes and simple scaling controls.
- CLI and API alongside the web UI.

## Architecture

- **Orchestrator underneath.** Docker Swarm handles scheduling, replicas, rolling updates and node
  failure — capabilities the SSH-and-Docker products in this cohort simply lack.
- **Controller** — CapRover itself runs as a service on the cluster it manages.
- **Ingress** — nginx configured by CapRover, with Let's Encrypt certificates.
- **State authority** — Swarm's own cluster state plus CapRover's configuration.
- **Portability boundary** — Swarm services and Docker images; the app definitions are CapRover's.

## Where CapRover is stronger

- **A real orchestrator underneath**, which is the substantive architectural difference in this
  cohort: replicas, rolling updates and rescheduling on node failure come free.
- **Multi-node from the start**, with genuine scheduling rather than a loop over SSH targets.
- **Mature and stable**, with a long history under its earlier name.
- **One-click templates** for the common self-hosted applications.
- **Simple mental model** despite the orchestrator, because the UI hides Swarm well.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | Rolling updates and replicas via Swarm |
| `environments` | Apps across a Swarm cluster |
| `extensibility` | One-click template catalog |

CapRover contests the self-hosted segment with a genuine scheduler underneath, which is more than
its peers offer and still stops well below HoBo's model.

## Primitive mapping

| CapRover | Nearest HoBo concept | Honest correspondence |
| -------- | -------------------- | --------------------- |
| App (Swarm service) | Bindle workload node | Partial; a service definition rather than a capability requirement. |
| Node | Camp substrate | Close. |
| **Swarm scheduling** | Provider matching | **Nested instance of the same problem** — placement onto nodes, decided by the orchestrator rather than by a scored contest between providers. |
| One-click app | Resource Pack | Partial. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** |

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Substrate independence** (*implemented*) — and pointedly, given CapRover's exposure to Swarm's
  trajectory: HoBo keeps its runtime behind a port precisely so a substrate's fortunes are not the
  platform's.
- **Provider-abstract description with scored placement** (*implemented*).
- **Policy, residency and replay** (*implemented*, ADR-0135/0146).
- **Honest caveat.** CapRover has real scheduling today; HoBo's advantage is the layer above, not the
  runtime beneath.

## Adversarial critique

- **Docker Swarm's trajectory is the central risk.** Swarm's ecosystem momentum went to Kubernetes
  years ago; CapRover's best architectural property rests on a substrate with limited investment,
  which is a strategic exposure rather than a technical flaw. Adopters should evaluate that
  directly rather than assume continuity.
- **Swarm's own limits become CapRover's** — networking behaviour, storage handling and observability
  are all Swarm's, and the ecosystem around them is thin.
- **Single controller** on the cluster, with the usual backup responsibility.
- **The template catalog is a supply chain**, as everywhere in this cohort.
- **No multi-tenancy or RBAC** worth the name; access to the UI is access to everything.
- **Abstraction leaks under failure** — debugging means understanding Swarm, which the UI otherwise
  hides.

## Better-together / integration posture

- **Benchmark** — the one product in this cohort that keeps genuine scheduling, and therefore the
  right comparison for what a self-hosted platform *can* offer.
- Not an adopt, borrow, provider, integrate or displace target.

## Threats and lessons

1. **Choosing a substrate is choosing its future.** CapRover made the architecturally better choice
   for its time and inherited the ecosystem outcome of the orchestrator it picked. This is the most
   direct cautionary parallel in the corpus for HoBo's own wasmCloud and component-model bet, and
   the mitigation is the same one HoBo already has: keep the substrate behind a port.
2. **Scheduling is the capability the simple tools lack**, and most teams do not notice until a node
   fails.
3. **A friendly UI over a real orchestrator** is a defensible product shape — and only as durable as
   the orchestrator.

## Sources

- [caprover.com/docs](https://caprover.com/docs/) — apps, one-click templates, nodes, TLS, deployment methods
- [caprover/caprover](https://github.com/caprover/caprover) — source and Apache-2.0 licence

Current project activity, Swarm version support and template-catalog health were not verified in this
pass and are not asserted.
