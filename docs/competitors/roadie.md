---
type: Competitive Reference
title: "Roadie — Competitor Reference"
description: "Managed Backstage: the upstream catalog, TechDocs and scaffolder as a hosted service, with catalog YAML and templates staying in the customer's repositories."
tags: [hobo, competitors]
competitor:
  slug: roadie
  name: "Roadie"
  aliases: ["roadie.io"]
  primary_category: developer-portals-idps
  categories: [developer-portals-idps]
  directness: complementary
  role: "hosted Backstage whose exit story — your catalog and templates stay yours — is the cleanest lock-in answer in this cohort"
  posture: [integrate, benchmark, borrow]
  hobo_surface: [app-graph, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://roadie.io/compare/backstage/
    - https://roadie.io/blog/backstage-alternatives/
    - https://roadie.io/compare/compass/
---

# Roadie — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**. Roadie publishes extensive competitor comparisons; those are treated
> as vendor claims here, and only its statements about its own product are used as evidence.

## What it is

Roadie is **managed Backstage**: "a comprehensive and maintenance-free IDP built on the open-source
version of Backstage" ([Roadie vs Backstage](https://roadie.io/compare/backstage/)). The customer
gets the upstream portal — catalog, TechDocs, Software Templates, plugins — without operating it.

The notable design commitment is the exit story, stated plainly in Roadie's own material: "Your
catalog definitions are YAML files in your repos. Your templates are portable. If you ever decide to
self-host, you can take everything with you."

- **Product boundary.** A hosted developer portal. No deployment, no provisioning.
- **Operating model.** Commercial SaaS over an open-source upstream.

## Core primitives and mental model

Roadie inherits Backstage's primitives unchanged:

| Primitive | What it is |
| --------- | ---------- |
| **Catalog entity** | Component, System, API, Resource, Group, User — declared in `catalog-info.yaml` in the customer's repositories |
| **TechDocs** | "A purpose-built docs-as-code system: Markdown files in your repos get compiled into searchable documentation sites" |
| **Software Template** | Scaffolder templates that generate new repositories from a golden path |
| **Plugin** | Upstream Backstage plugins, curated and operated by Roadie |

The mental model is **Backstage as a service, with the substrate staying in your repositories**. The
portal is rented; the model is owned.

## Feature surface

- Hosted Backstage catalog with the upstream entity model.
- TechDocs: docs-as-code compiled from repository Markdown, searchable.
- Software Templates for scaffolding.
- Curated, operated plugin set.
- Managed upgrades — the value proposition, since upstream Backstage upgrades are the recurring cost.

## Architecture

- **Control plane** — Roadie's hosted service running Backstage.
- **Data plane** — none; it reads repositories and connected systems.
- **State authority** — `catalog-info.yaml` files in the customer's repositories. This is the
  architecturally important choice: the source of truth is the customer's, not the vendor's.
- **Portability boundary** — the best in this cohort. Catalog YAML and scaffolder templates are
  upstream Backstage artifacts; moving to self-hosted Backstage or another distribution preserves
  the modelling work.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `app-graph` | The Backstage catalog, hosted |
| `extensibility` | The upstream plugin ecosystem, operated for you |

No overlap with placement, deployment, policy decisions or runtime.

## Primitive mapping

| Roadie | Nearest HoBo concept | Honest correspondence |
| ------ | -------------------- | --------------------- |
| Catalog entity | Materialized view over deployed resources | Close in role; declared rather than derived. |
| TechDocs | — | **No HoBo equivalent, and none needed** — docs-as-code is not a control-plane concern. |
| Software Template | Resource/App Pack | Partial: scaffolds a repository rather than describing deployable capability. |
| Plugin | Provider adapter | Partial. |

## Where Roadie is stronger

- **The exit story is genuinely good**, and rare: the customer's investment lives in their own
  repositories in an open format. Most SaaS in this corpus cannot say that.
- **Managed upgrades** address Backstage's real cost, which is keeping a fork current.
- **TechDocs included** — a documentation system most competitors in this cohort simply lack.
- **Upstream compatibility** means the plugin ecosystem is the whole Backstage ecosystem.

## Where HoBo is stronger or intentionally different

- **HoBo is a control plane** (*implemented*): it places, deploys, decides and records.
- **Derived rather than declared graph** (*implemented*, ADR-0135) — no `catalog-info.yaml` to go
  stale.
- **Honest caveat.** Roadie is not a HoBo competitor in any meaningful sense; it is a portal HoBo
  should integrate with, and the capture exists to record that judgement rather than to score points.

## Adversarial critique

- **It is Backstage, with Backstage's limits** — including a catalog whose accuracy depends on
  developers maintaining YAML, which is the failure mode auto-discovering competitors target.
- **Value is operational, not functional.** The product is "we run it for you", so its differentiation
  erodes if upstream Backstage becomes easier to operate.
- **Plugin curation constrains** relative to self-hosting, which is the usual managed-service trade.
- **Small vendor in a category with much larger entrants** — Red Hat, Atlassian, and well-funded
  independents.
- **Competitor-comparison-heavy marketing** makes independent evaluation harder, and its claims about
  rivals should not be taken at face value in either direction.

## Better-together / integration posture

- **Integrate** — HoBo as a catalog source; Roadie as the portal surface.
- **Borrow** — **keep the customer's model in the customer's repositories**. Roadie's exit story is a
  design principle HoBo already believes in and states less clearly; it is worth stating exactly this
  way.
- Not a displace, adopt, provider, or render target.

## Threats and lessons

1. **"You can take everything with you" is a sales advantage, not just an ethic.** It closes deals in
   a category full of proprietary models. HoBo's portability argument is the same argument, one layer
   down, and should be phrased as plainly.
2. **Operating open source is a viable business** and a reminder that HoBo's open core does not
   preclude a hosted offering.
3. **Docs-as-code keeps appearing in developer-facing products** and is absent from control planes,
   correctly.

## Sources

- [Roadie vs Backstage](https://roadie.io/compare/backstage/) — managed Backstage positioning, TechDocs, portability of catalog and templates (vendor material)
- [Backstage alternatives guide](https://roadie.io/blog/backstage-alternatives/) and [Compass comparison](https://roadie.io/compare/compass/) — category framing and competitor claims (vendor material, not used as evidence about rivals)

Pricing, plugin curation policy, and current customer scale were not verified in this pass and are
not asserted.
