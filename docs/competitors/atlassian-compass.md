---
type: Competitive Reference
title: "Atlassian Compass — Competitor Reference"
description: "SaaS developer portal whose advantage is Atlassian-ecosystem integration; notable for what it has removed — scaffolding templates were retired in December 2025 with no replacement."
tags: [hobo, competitors]
competitor:
  slug: atlassian-compass
  name: "Atlassian Compass"
  aliases: ["compass"]
  primary_category: developer-portals-idps
  categories: [developer-portals-idps]
  directness: complementary
  role: "ecosystem-distribution portal — a reminder that in this category integration reach and vendor commitment matter more than architecture"
  posture: [integrate, benchmark]
  hobo_surface: [app-graph, governance]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://www.atlassian.com/software/compass
    - https://www.atlassian.com/software/compass/comparison/compass-vs-backstage
    - https://developer.atlassian.com/cloud/compass/
---

# Atlassian Compass — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.

## What it is

Compass is **Atlassian's SaaS developer portal**: a component catalog with ownership, scorecards and
metrics, sold into organizations already standardized on Jira, Confluence and Bitbucket. Atlassian's
own comparison material frames the distinction from Backstage simply — "Backstage is a self-hosted
solution, while Compass is a SaaS solution maintained by Atlassian"
([comparison](https://www.atlassian.com/software/compass/comparison/compass-vs-backstage)).

- **Product boundary.** Catalog, ownership, scorecards, metrics, and an extension API. It does not
  deploy, provision, or document.
- **Operating model.** Commercial SaaS, tightly bound to the Atlassian cloud.
- **The real advantage is distribution.** For teams whose issues, docs and repositories already live
  in Atlassian, the component catalog arrives pre-connected to the systems that matter.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Component** | The catalog unit — service, library, application — with type and ownership |
| **Team** | The owning Atlassian team, shared with the rest of the suite |
| **Scorecard** | Rules expressing engineering standards across components |
| **Metric** | Tracked signal attached to a component (deployment frequency, incident counts) |
| **Event** | Activity stream from connected tools, giving components a timeline |
| **Forge app** | The extension mechanism, using Atlassian's developer platform |

The mental model is **components inside the Atlassian graph**: a component is another object
alongside issues, pages and repositories, and its value comes from being adjacent to them.

## Feature surface

- Component catalog with types and ownership.
- Scorecards for engineering standards.
- Metrics and activity timelines fed by connected tooling.
- Deep integration with Jira, Confluence, Bitbucket and Atlassian identity.
- Forge-based extensibility.
- **No documentation engine.** Atlassian's competitors note that Compass has no built-in system for
  creating, building or searching technical documentation, and links to external docs instead — an
  absence consistent with Confluence occupying that role in the suite.
- **No scaffolding.** Templates were removed from Compass on 1 December 2025, with no replacement.

## Architecture

- **Control plane** — Atlassian cloud.
- **Data plane** — none; Compass observes and links.
- **State authority** — Atlassian's component store, in Atlassian's format.
- **Extension model** — Forge, which means extensions are Atlassian-platform artifacts rather than
  portable plugins.
- **Portability boundary** — the weakest in this cohort. Component data, scorecards and
  configuration live in Atlassian's proprietary format; there is no repository-resident source of
  truth to take away.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `app-graph` | A component catalog, pre-wired to where work already happens |
| `governance` | Scorecards and metrics |

Compass contests none of HoBo's control-plane surface. It matters to this corpus mainly as evidence
about the category rather than as a competitor.

## Primitive mapping

| Compass | Nearest HoBo concept | Honest correspondence |
| ------- | -------------------- | --------------------- |
| Component | Materialized view over deployed resources | Close in role; declared and enriched rather than derived. |
| Team | Tenant / owner | Compass inherits Atlassian's org model, which is richer than HoBo's. |
| Scorecard | `@hobo/policy` pack | Measurement versus admission decision, as elsewhere in this cohort. |
| Metric | Observability read model | Partial. |
| Forge app | Provider adapter | Only structurally — a vendor-platform extension model. |

## Where Compass is stronger

- **Distribution.** For an Atlassian-standardized organization, adoption cost is close to zero and
  the catalog is immediately connected to the systems people already use.
- **Shared identity and teams** across the suite, avoiding the org-modelling problem other portals
  must solve from scratch.
- **Activity timelines** are genuinely useful when the connected tools are the ones the organization
  actually works in.
- **Vendor scale** — support, compliance and procurement are settled questions.

## Where HoBo is stronger or intentionally different

- **HoBo is a control plane** (*implemented*): decisions, placement, promotion, records.
- **Derived graph from an authoritative log** (*implemented*, ADR-0135).
- **Open and self-hostable** (*implemented*), against a closed SaaS with a proprietary model.
- **Honest caveat.** These are different products; the comparison exists to place Compass in the
  taxonomy, not to claim a contest.

## Adversarial critique

- **Feature removal is the headline risk.** Retiring scaffolding templates in December 2025 with no
  replacement is a material narrowing of the product for customers who had adopted it, and it is the
  most instructive fact in this capture: in a strategically secondary product, capabilities can be
  withdrawn.
- **No documentation engine** leaves a core portal function to Confluence, which is fine inside the
  suite and a gap outside it.
- **Proprietary format, no repository-resident truth.** Nothing survives an exit — the opposite of
  Roadie's position, and the clearest illustration of why that matters.
- **Ecosystem lock-in is the value proposition**, which means the product's appeal and its
  switching cost are the same property.
- **Secondary product risk.** Compass is not central to Atlassian's business the way Jira is, and the
  template removal is evidence about how that plays out.
- **Thin extensibility relative to Backstage's ecosystem**, since Forge apps are a smaller and more
  constrained population than Backstage plugins.

## Better-together / integration posture

- **Integrate** — HoBo as a component and metric source for organizations that live in Atlassian.
- **Benchmark** — only on adoption friction, where being already-installed is unbeatable.
- Not a displace, adopt, borrow, provider, or render target: there is no mechanism here HoBo wants.

## Threats and lessons

1. **Vendors withdraw features from secondary products.** This is the strongest argument for a
   customer keeping their model in their own repositories, and it happened in this category within
   the last year. HoBo should say so when explaining why its manifests live in the customer's repo.
2. **Distribution beats architecture in portals.** Compass wins accounts on adjacency alone. HoBo's
   response is integration, not imitation — the same conclusion the whole cohort reaches.
3. **A catalog with no docs and no scaffolding is a directory.** The category's centre of gravity is
   the *workflows* attached to the catalog, and products that shed them drift toward being a list.

## Sources

- [Atlassian Compass](https://www.atlassian.com/software/compass) — product overview
- [Compass vs Backstage](https://www.atlassian.com/software/compass/comparison/compass-vs-backstage) — SaaS-versus-self-hosted framing (vendor material)
- [Compass developer documentation](https://developer.atlassian.com/cloud/compass/) — extension model
- Template removal (1 December 2025) and the absence of a documentation engine are reported in
  competitor material and are recorded here as claims that a buyer should verify directly with
  Atlassian rather than as independently confirmed facts.

Pricing, current roadmap and the Forge app catalog were not verified in this pass and are not
asserted.
