---
type: Competitive Reference
title: "Dokku — Competitor Reference"
description: "The original single-server Heroku clone: git push to deploy, buildpacks, plugins, and a decade of stability on one box."
tags: [hobo, competitors]
competitor:
  slug: dokku
  name: "Dokku"
  aliases: ["dokku.com"]
  primary_category: self-hosted-paas
  categories: [self-hosted-paas]
  directness: adjacent
  role: "the long-lived single-server PaaS — proof that the Heroku contract is small enough to reimplement and durable enough to last a decade"
  posture: [benchmark]
  hobo_surface: [authoring, delivery, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://dokku.com/docs/
    - https://github.com/dokku/dokku
---

# Dokku — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.

## What it is

Dokku is **the original open-source Heroku clone for a single server**: `git push dokku main` builds
your application with a buildpack and runs it behind a proxy, on a machine you own. It began as a
few hundred lines of shell and has been maintained for over a decade.

Its value to this corpus is longevity. Most of this cohort is a few years old; Dokku demonstrates
what survives.

- **Product boundary.** Build and run applications on one host, with plugins for datastores and TLS.
- **Operating model.** Self-hosted, single server by design (multi-host exists via scheduler
  plugins, but one box is the shape).
- **Commercial status.** Open source (MIT), community-maintained with sponsorship.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **App** | The unit: a Git remote you push to |
| **Buildpack / Dockerfile** | How source becomes a runnable image — Cloud Native Buildpacks or your own Dockerfile |
| **Plugin** | The extension mechanism: Postgres, Redis, Let's Encrypt, and hundreds more |
| **Proxy** | nginx or Traefik fronting the apps |
| **Process type** | `Procfile`-declared processes, scaled by count |

The mental model is **Heroku's contract, on your box**: twelve-factor application, buildpack build,
config vars, process scaling, add-ons as plugins. Dokku's contribution is showing that this contract
is small enough to reimplement in shell and stable enough to remain useful across a decade of
industry churn.

## Feature surface

- Git push deploys, plus deploys from Docker images.
- Cloud Native Buildpacks and herokuish support.
- Plugin ecosystem for datastores, TLS, monitoring, backups.
- Zero-downtime deploys with health checks.
- `Procfile` process types and per-process scaling.
- Config vars, domains, and per-app proxy settings.

## Architecture

- **Single host, no controller.** Dokku is a set of commands and hooks on the server itself; there is
  no separate control plane to run or lose.
- **Execution** — Docker containers, built by buildpacks, fronted by nginx or Traefik.
- **Plugins** — shell-based lifecycle hooks, which is why the ecosystem is large and uneven.
- **State authority** — the server's own filesystem and Docker state.
- **Portability boundary** — buildpacks are a genuine standard, so the *build* is portable; the
  plugin configuration and host layout are not.

## Where Dokku is stronger

- **Ten-plus years of stability.** Nothing else in this cohort has that record, and for a
  self-hosted tool it is the single most valuable property.
- **No control plane to operate.** The server is the platform.
- **Buildpack support** means no Dockerfile is required for common stacks.
- **Enormous plugin ecosystem** for a project of its size.
- **Genuinely tiny operational footprint**, which suits the one-box case exactly.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | None required — push a repository and a buildpack does the rest |
| `delivery` | Git push, build, zero-downtime swap |
| `extensibility` | A large shell-plugin ecosystem for datastores and TLS |

Dokku contests the one-server case and nothing above it: no placement decision, no policy, no
application model beyond a `Procfile`.

## Primitive mapping

| Dokku | Nearest HoBo concept | Honest correspondence |
| ----- | -------------------- | --------------------- |
| App | Bindle workload node | Partial — a buildpack-built container, not a capability requirement. |
| Buildpack | Build path | Close; Cloud Native Buildpacks are a genuine shared standard. |
| Plugin | Provider adapter | **Weakly.** A shell plugin installs software; a HoBo adapter implements a typed contract. |
| Process type | Workload role | Close. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** |

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Everything above single-host deployment** (*implemented*): capability contracts, scored
  placement, policy, residency, replay.
- **Provider-abstract targets** (*implemented*) rather than one machine.
- **Honest caveat.** For one application on one server, Dokku has been the right answer for a decade
  and HoBo is not competing for that job.

## Adversarial critique

- **One server is the design, not a starting point.** Multi-host support exists through scheduler
  plugins and is not what the tool is shaped for; teams outgrowing a single box are usually leaving.
- **Shell-based plugins age unevenly.** The ecosystem's breadth is real and its maintenance is
  distributed across many small repositories with varying activity.
- **No multi-tenancy or RBAC.** Server access is the authorization model.
- **Buildpacks are a mixed inheritance** — excellent when they fit, opaque when they do not.
- **Backups and datastore operations are plugin-dependent**, so durability quality varies by plugin
  rather than being a platform property.
- **No reconciliation or scheduling**: what runs is what was started.

## Better-together / integration posture

- **Benchmark** — Dokku sets the floor for the one-server case and demonstrates the durability HoBo's
  self-host story should aim for.
- Not an adopt, borrow, provider, integrate or displace target — this capture exists to place the
  category's longest-lived member accurately.

## Threats and lessons

1. **The Heroku contract is small and durable.** A decade of maintenance on one implementation is
   evidence that twelve-factor deployment is a stable problem, and that competing on it is competing
   on distribution rather than capability.
2. **Longevity is a feature self-hosters value most**, and it is the property newest entrants cannot
   claim. HoBo's stability posture matters more in this segment than its capability.
3. **No control plane means nothing to break** — the third occurrence of this observation in the
   cohort, after Kamal and Coolify's single-controller weak point.

## Sources

- [dokku.com/docs](https://dokku.com/docs/) — apps, buildpacks, plugins, proxy, process types
- [dokku/dokku](https://github.com/dokku/dokku) — source and MIT licence

Current plugin-ecosystem health and multi-host scheduler support were not verified in this pass and
are not asserted.
