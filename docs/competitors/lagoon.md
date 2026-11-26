---
type: Competitive Reference
title: "Lagoon — Competitor Reference"
description: "Open-source application delivery platform: one .lagoon.yml plus the project's own docker-compose.yml drive builds and Kubernetes deployment, with local and production sharing images."
tags: [hobo, competitors]
competitor:
  slug: lagoon
  name: "Lagoon"
  aliases: ["uselagoon", "amazee.io lagoon"]
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, self-hosted-paas, delivery-release-gitops]
  directness: adjacent
  role: "open-source delivery platform whose local-equals-production promise is built on reusing the developer's existing docker-compose file as the source of truth"
  posture: [benchmark, borrow]
  hobo_surface: [authoring, environments, delivery, runtime-portability]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.lagoon.sh/
    - https://docs.lagoon.sh/concepts-basics/docker-compose-yml/
    - https://docs.lagoon.sh/lagoonizing/
    - https://github.com/uselagoon/lagoon
---

# Lagoon — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-19**.

## What it is

Lagoon is an **open-source, developer-focused application delivery platform**, "originally created
and open sourced by the team at amazee.io in August 2017", and it "powers their global hosting
platform" ([docs](https://docs.lagoon.sh/)). It "runs on Docker and Kubernetes".

Its stated goal is the one every platform claims and few structure their product around:

> "A system that allows developers to locally develop their code and their services with Docker and
> run the exact same system in production. The same Docker images, the same service configurations
> and the same code."

- **Product boundary.** Build and deploy: take a repository, build images, deploy them to
  Kubernetes, and manage the resulting environments. Not an infrastructure provisioner.
- **Operating model.** Open source and self-hostable
  ([uselagoon/lagoon](https://github.com/uselagoon/lagoon)), and simultaneously the engine behind a
  commercial hosting business — a combination that gives it unusually honest operational evidence.
- **Heritage.** Drupal and PHP hosting at agency scale, which shows in its assumptions: many similar
  sites, per-project environments, and developers who already have a `docker-compose.yml`.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **`.lagoon.yml`** | The only file Lagoon requires: "Lagoon only requires a single `.lagoon.yml` file to be present in your Git repository. This file instructs Lagoon on where to find the docker-compose configuration necessary to build the environment's containers." |
| **`docker-compose.yml`** | **The developer's existing file**, reused as the topology source of truth |
| **Service** | An entry in the compose file; "the name of the service … is used by Lagoon as the name of the Kubernetes pod that is generated, plus also any additional Kubernetes objects that are created" |
| **`lagoon.type` label** | The translation key: "Lagoon needs to know what type of service you are deploying in order to configure the correct Kubernetes or OpenShift objects. This is done via the `lagoon.type` label." |
| **Environment** | A deployed branch/PR instance of a project |

The mental model is the most economical authoring decision in this corpus: **do not invent an
application model — annotate the one the developer already has.** A `docker-compose.yml` already
describes services, images, ports and dependencies. Lagoon adds one label per service saying what
kind of thing it is, and derives Kubernetes objects from that.

The deployment loop is documented plainly: Lagoon builds images, "pushes them to a Docker registry",
"creates the needed resources in Kubernetes", "monitors the deployment of the containers", and "when
all is done, Lagoon informs the developers in different ways (Slack, email, website, etc)".

## Feature surface

- **Authoring** — one `.lagoon.yml` plus labels on an existing compose file; the "Lagoonizing"
  workflow is documented as an explicit onboarding path for existing sites.
- **Resource model** — compose services, typed by `lagoon.type`, translated to Kubernetes objects.
- **Environments** — per-branch/PR environments with project-scoped configuration.
- **Delivery** — build → registry push → Kubernetes apply → monitor → notify.
- **Local/production parity** — the same images and service configuration run in both.
- **Notifications** — Slack, email and web, as first-class deployment output.
- **CLI** — [`lagoon-cli`](https://github.com/uselagoon/lagoon-cli) for project and environment
  operations.
- **Runtimes** — Kubernetes, with OpenShift object support noted in the same translation layer.

## Architecture

- **Control plane** — Lagoon's own services (API, build orchestration, task handling) running in a
  cluster, self-hosted or operated by amazee.io.
- **Data plane** — Kubernetes (or OpenShift) namespaces holding the generated objects.
- **Translation layer** — the interesting part: `lagoon.type` maps a compose service to a set of
  Kubernetes objects. The abstraction is a lookup from a familiar vocabulary to an unfamiliar one,
  not a new model.
- **Build model** — images built from the repository and pushed to a registry, then deployed; the
  same images that ran locally.
- **State authority** — Kubernetes resources plus Lagoon's own project/environment database. No
  event log or decision replay.
- **Portability boundary** — modest but real: because the source of truth is a standard
  `docker-compose.yml`, the *inputs* survive leaving Lagoon even though the deployment machinery
  does not. That is a better position than a bespoke manifest format.

## How it competes with HoBo

Lagoon is **adjacent rather than competing** — it does not model applications abstractly, choose
providers, or claim portability. What it contests is the authoring on-ramp, and it does so with a
strategy HoBo should take seriously.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | **The real contest.** Zero new topology to write — annotate what exists |
| `environments` | Per-branch environments |
| `delivery` | A complete, observable build-and-deploy loop with notifications |
| `runtime-portability` | Only in the local-equals-production sense, which is a different (and narrower) claim than cross-provider portability |

## Primitive mapping

| Lagoon | Nearest HoBo concept | Honest correspondence |
| ------ | -------------------- | --------------------- |
| `docker-compose.yml` service | Bindle workload node | **Partial.** A compose service is a container specification; a Bindle node is a capability requirement. Lagoon inherits the developer's file; HoBo asks for a new description. |
| `lagoon.type` label | Bindle kind selection | **Genuinely close, and pleasantly small.** Both answer "what kind of thing is this?" so the platform can realize it. HoBo's kinds carry contracts and impedance limits; a label carries a name. |
| `.lagoon.yml` | Bindle manifest metadata | Partial. |
| Environment | Camp | Close in role; Lagoon's is always a Kubernetes namespace. |
| Build → registry → deploy → notify | Delivery pipeline + promotion events | Partial; HoBo's transitions are policy-gated events. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** One substrate, no choice to record. |

## Where Lagoon is stronger

- **The lowest-ceremony on-ramp in the corpus.** Bring your existing compose file, add labels, done.
  No new topology language, no rewrite, no migration project.
- **Local-equals-production is structurally enforced**, not aspirational: the same images and
  service configuration are used in both, because both come from the same file.
- **Genuinely open source with real production evidence** — the same code runs a commercial hosting
  platform at scale, which is a stronger correctness signal than either OSS or SaaS alone.
- **"Lagoonizing" is a documented migration path**, treating adoption of an existing application as
  the normal case rather than an afterthought.
- **Notifications as a first-class output** — small, and a real part of why teams like it.

## Where HoBo is stronger or intentionally different

- **Provider-abstract application description** (*implemented*). Lagoon's abstraction bottoms out in
  Kubernetes objects; a Bindle can target managed services, wasm hosts, or a local runtime.
- **Typed contracts rather than a label** (*implemented*). `lagoon.type` names a translation; a
  BoundaryContract carries semantics, effects (ADR-0136) and impedance limits (ADR-0144).
- **Placement is decided and recorded** (*implemented*, `match.Decided`); Lagoon has one target.
- **Fail-closed residency** (*implemented*, ADR-0146) and **event-sourced replay** (*implemented*,
  ADR-0135).
- **Broader workload shapes.** Compose describes long-running containers well and actors, durable
  workflows and serverless functions not at all.
- **Honest caveat.** On *time to first successful deploy for an existing application*, Lagoon is
  ahead of HoBo, and that is the metric most adoption decisions actually turn on.

## Adversarial critique

- **Compose is a weak topology language.** It has no notion of capability, dependency semantics
  beyond start order, environment differentiation, or policy. Everything beyond "containers that
  talk to each other" must be bolted on.
- **`lagoon.type` is a closed vocabulary in practice.** Extending it means changing the platform, not
  writing a plugin — so the abstraction is only as broad as the maintainers' type list.
- **Kubernetes is mandatory** and visible when things fail; the compose-shaped mental model does not
  help debug a CrashLoopBackOff.
- **CMS/agency shape shows.** The product assumes many similar projects with per-project
  environments; teams outside that pattern get less benefit from its strongest features.
- **Operating Lagoon is real work.** Self-hosting means running its control plane, build system and
  registry integration — a substantial commitment for a platform whose value is convenience.
- **Local parity is image parity, not environment parity.** Data, scale, network policy and managed
  services still differ between laptop and production, which is where most "works on my machine"
  failures actually originate.
- **Narrow modern-runtime coverage.** No serverless, no actor model, no wasm.

## Better-together / integration posture

- **Borrow** — and this is the most actionable adoption lesson in the corpus: **meet the developer at
  the file they already have.** A `hobo import` path that reads an existing `docker-compose.yml` and
  proposes Bindle kinds per service would give HoBo a Lagoon-class on-ramp without adopting
  Lagoon's ceiling. This is the third corpus occurrence of the same finding (after Massdriver's
  "point at your OpenTofu module" and NetScaler's `nsconf2iac`), which makes it a pattern rather
  than an idea.
- **Benchmark** on time-to-first-deploy for an application that already exists.
- Not a displace, adopt, provider, or render target — different ambitions.

## Threats and lessons

1. **On-ramp beats model quality in adoption decisions.** A better application model that requires
   writing something new loses to a worse one that requires writing almost nothing. HoBo needs an
   import path, not just a good manifest.
2. **Third independent occurrence of the import-existing-artifacts finding.** Compose files here,
   OpenTofu modules in Massdriver, device configs in NetScaler. This is now a well-evidenced gap and
   belongs in its own implementation issue.
3. **Local-equals-production is a promise worth structuring the product around.** HoBo's local
   runtime already makes this technically possible; the claim is not made prominently, and Lagoon
   shows how much it is worth.
4. **Open source plus a commercial operator is a credibility structure**, not just a licence choice:
   it produces operational evidence that neither pure OSS nor pure SaaS generates.

## Sources

- [Lagoon documentation](https://docs.lagoon.sh/) — positioning, the local-equals-production goal, the build/deploy/notify loop, `.lagoon.yml` as the only required file
- [docker-compose.yml concepts](https://docs.lagoon.sh/concepts-basics/docker-compose-yml/) — service naming, generated Kubernetes objects, the `lagoon.type` label
- [Lagoonizing your existing site](https://docs.lagoon.sh/lagoonizing/) — the migration path for existing applications
- [uselagoon/lagoon](https://github.com/uselagoon/lagoon) and [uselagoon/lagoon-cli](https://github.com/uselagoon/lagoon-cli) — source and CLI

The current `lagoon.type` catalog, amazee.io's commercial packaging, and v2 changes were not
verified in this pass and are not asserted.
