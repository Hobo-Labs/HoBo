---
type: Competitive Reference
title: "Cycloid — Competitor Reference"
description: "GitOps-first platform-engineering portal: Stacks + StackForms turn IaC into self-service forms, with TerraCost estimation, InfraView topology, and native FinOps/GreenOps."
tags: [hobo, competitors]
competitor:
  slug: cycloid
  name: "Cycloid"
  aliases: ["cycloid.io"]
  primary_category: platform-orchestrators
  categories: [platform-orchestrators, developer-portals-idps, finops-governance-placement, hybrid-multicloud-enterprise]
  directness: overlapping
  role: "self-service portal over templated IaC whose pre-provision cost estimation and auto-generated topology view are the surfaces HoBo most visibly lacks"
  posture: [benchmark, borrow, integrate]
  hobo_surface: [authoring, environments, finops, observability, governance, app-graph]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://www.cycloid.io/product/infraview/
    - https://www.cycloid.io/open-source/terracost/
    - https://docs.cycloid.io/guide/terracost.html
    - https://www.cycloid.io/platform-engineering-for-enterprise/
---

# Cycloid — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-19**. Much of Cycloid's public material is marketing rather than
> reference documentation; claims resting on marketing alone are labelled as such, and the
> open-source components are treated as the strongest evidence.

## What it is

Cycloid is a **commercial platform-engineering product** built around turning a platform team's
infrastructure-as-code into a self-service form for developers. It differentiates on "a GitOps-first
architecture, open source foundations (TerraCognita, InfraMap, TerraCost), and native FinOps and
GreenOps modules built into the platform"
([enterprise page](https://www.cycloid.io/platform-engineering-for-enterprise/)).

- **Product boundary.** The self-service and visibility layer over existing IaC — not a runtime, and
  not a replacement for Terraform.
- **Operating model.** Commercial product; several genuinely useful components are open-sourced
  (TerraCost, InfraMap, TerraCognita), which is unusual in this cohort and worth crediting.
- **The GreenOps angle is distinctive.** Carbon/sustainability reporting sits alongside cost as a
  first-class module; no other product in this corpus treats it as a primary axis.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Stack** | A reusable infrastructure template authored by the platform team "using Terraform, Ansible, or Helm" |
| **StackForms** | "A configuration layer that turns IaC variables into a self-service form" — the developer-facing surface, with "pre-approved options. No Terraform knowledge required" |
| **TerraCost** | Open-source cost estimation that "estimates the price of an infrastructure based on the related Terraform", integrated "into Pipelines and StackForms" so it predicts "the cost of a new deployment as you configure it" |
| **InfraView** | "A centralised graphical representation of all cloud infrastructure across AWS, Azure, GCP, OpenStack, and Flexible Engine, generated automatically from the Terraform source so diagrams stay current without manual maintenance" |
| **Pipelines** | The delivery mechanism executing stacks |
| **TerraCognita / InfraMap** | Open-source tools for importing existing infrastructure into Terraform, and for diagramming it |

The mental model is **the form is the product**: a platform team encodes approved choices in a
Stack, StackForms exposes exactly those choices as variables, and a developer fills in a form. Cost
appears *while filling the form*, which is the genuinely good idea here — the economic consequence
of a choice is visible at the moment the choice is made, rather than on next month's bill.

## Feature surface

- **Authoring** — platform teams write Terraform/Ansible/Helm stacks; developers fill forms.
- **Resource model** — whatever the underlying IaC declares; Cycloid does not impose its own.
- **Environments** — per-environment views (Dev, Staging, Prod) with resource metadata.
- **Providers** — AWS, Azure, GCP, OpenStack and Flexible Engine (the last two are notable: OpenStack
  and OVH-family support is rare and points at European/sovereign-cloud customers).
- **Delivery** — GitOps-first pipelines.
- **Cost** — TerraCost estimation pre-provision, plus FinOps reporting after.
- **Sustainability** — GreenOps carbon reporting.
- **Visibility** — InfraView topology diagrams "generated automatically from the Terraform source",
  showing "connections between resources per environment" and surfacing "up-to-date resource
  metadata (IPs, VM sizes, dependencies)".
- **Import** — TerraCognita reverse-engineers existing cloud estates into Terraform.
- **Governance** — pre-approved options are the enforcement mechanism: a developer can only pick
  what the form offers.

## Architecture

- **Control plane** — Cycloid's product: stack catalog, form definitions, pipelines, cost and
  topology views.
- **Execution** — Terraform / Ansible / Helm against the customer's clouds, GitOps-driven.
- **State authority** — Git plus Terraform state. Cycloid is a layer above rather than a new
  authority, which keeps its blast radius small and its exit cost low.
- **Portability boundary** — none of its own. A stack is as portable as the IaC inside it; Cycloid
  neither helps nor hinders. This is a coherent choice, not an omission.

## How it competes with HoBo

Cycloid competes with HoBo **at the edges rather than the centre**. It has no application model and
no provider-matching engine, so it does not contest HoBo's core. What it does contest is everything
a user actually sees.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | StackForms is a simpler authoring surface than any manifest: it is a form |
| `finops` | **Pre-provision cost estimation at the point of choice** — the strongest overlap, and ahead of HoBo's surfaced experience |
| `app-graph` | InfraView is an auto-generated, always-current topology view |
| `environments` | Per-environment resource views |
| `governance` | Constrained choice as the enforcement mechanism |
| `observability` | Infrastructure visibility and metadata |

The uncomfortable observation: Cycloid solves the *presentation* problems HoBo has not, while
declining the *modelling* problems HoBo has solved. A prospect comparing demos sees a cost figure
update as they pick an instance size, and a topology diagram that maintains itself.

## Primitive mapping

| Cycloid | Nearest HoBo concept | Honest correspondence |
| ------- | -------------------- | --------------------- |
| Stack | Resource Pack / provider adapter | **Partial.** A Stack is concrete IaC for one realization; a Resource Pack implements abstract kinds. |
| StackForms | Authoring surface | **Different in kind.** HoBo's authoring is a typed program; StackForms is a generated form over IaC variables. Neither subsumes the other — a form cannot express a topology, and a manifest is not a form. |
| TerraCost | Cost inputs to provider matching | **Same data, opposite direction.** TerraCost *shows* the user the cost of their choice; HoBo *feeds* cost into a decision the platform makes. Both are legitimate; HoBo lacks the visible-at-choice-time surface. |
| InfraView | App graph view | **No HoBo equivalent** (*not-present*). The auto-generation-from-source property is the valuable part: diagrams that cannot go stale. |
| Pipelines | Stage gates + promotion | Partial; HoBo's are policy-gated events. |
| Pre-approved options | `@hobo/policy` packs | **Different enforcement point.** Cycloid constrains the *choice*; HoBo decides on the *request*. Constraining the form is simpler and weaker — it cannot express a rule that depends on runtime context. |
| TerraCognita (import) | `hobo import` | Close in intent; Cycloid's is shipped and open source. |
| GreenOps | — | **No HoBo equivalent.** Carbon as a placement input is an interesting unclaimed axis. |
| — | Bindle / `match.Decided` / `PortabilityReport` | **No equivalent.** Cycloid does not model applications and does not decide placement. |

## Where Cycloid is stronger

- **Cost visible at the moment of choice.** TerraCost inside StackForms is the single best FinOps
  interaction in this corpus, and it is open source.
- **Self-maintaining topology diagrams.** InfraView generating from Terraform source means the
  diagram cannot drift from reality — a much stronger property than a hand-maintained catalog.
- **Genuine open-source contribution.** TerraCost, InfraMap and TerraCognita are usable
  independently of the product; that earns credibility the marketing does not.
- **Lowest-friction developer surface in the cohort.** A form beats a manifest for the majority of
  requests, and pre-approved options make governance invisible rather than obstructive.
- **OpenStack and Flexible Engine support** — sovereign-cloud reach most competitors ignore.
- **GreenOps** as a first-class module.
- **Low exit cost.** The IaC underneath is ordinary and portable; removing Cycloid leaves working
  Terraform.

## Where HoBo is stronger or intentionally different

- **There is an application model at all** (*implemented*). Cycloid orchestrates infrastructure
  requests; HoBo describes applications and their topology. Forms cannot express dependency graphs.
- **Placement is decided and recorded** (*implemented*, `match.Decided`). Cycloid's placement is
  whatever the stack hard-codes.
- **Portability is scored** (*implemented*, ADR-0144) — Cycloid makes no portability claim to score.
- **Policy decides on requests, not on form fields** (*implemented*). Context-dependent rules —
  residency, budget, capability — cannot be expressed as a constrained dropdown.
- **Fail-closed residency** (*implemented*, ADR-0146), which matters specifically for the
  sovereign-cloud customers Cycloid's OpenStack support implies.
- **Event-sourced control plane with replay** (*implemented*, ADR-0135).
- **Honest caveat.** On the two surfaces Cycloid contests — visible cost at choice time, and a
  self-maintaining topology view — HoBo is currently behind, and both are *not-present* rather than
  merely immature.

## Adversarial critique

- **Forms do not scale to topology.** StackForms is excellent for "give me a database" and cannot
  express "this service depends on that queue which must be in this region". The abstraction's
  ceiling is low and is reached quickly by exactly the sophisticated teams the enterprise page
  targets.
- **Stack authoring is the same old problem.** Someone still writes and maintains Terraform per
  offering; the form layer adds a maintenance surface on top rather than removing one.
- **Governance by dropdown is brittle.** Constrained choice cannot express conditional policy, and
  it fails open the moment a developer needs something the form does not offer — at which point they
  route around the platform.
- **Marketing-heavy public surface.** Reference documentation is thin relative to the claims; several
  product assertions could not be corroborated from docs in this pass, and are not asserted here.
- **Cost estimation is an estimate.** Terraform-derived pricing cannot see usage-based charges,
  egress, or commitment discounts. Presenting a number at choice time is powerful precisely because
  users trust it, which makes its blind spots consequential.
- **No differentiated moat.** The genuinely good parts are open source and reimplementable; the rest
  is a portal. Larger suites can and do absorb this category.
- **Smaller vendor** with correspondingly higher procurement risk for the enterprises addressed.

## Better-together / integration posture

- **Borrow**, and these are among the most actionable borrows in the corpus:
  1. **Cost at the point of choice.** HoBo has the cost inputs; it does not show the consequence
     while the user is deciding. TerraCost is open source and its approach — price the plan from the
     declaration, before apply — maps directly onto HoBo's matching output.
  2. **Topology generated from source.** InfraView's property that matters is not the picture but
     that the picture *cannot be stale*. HoBo's graph is derived from an event log, which is an even
     better generator than Terraform files.
  3. **GreenOps.** Carbon as an input to placement is unclaimed, fits HoBo's scored-matching model
     exactly, and would be a genuine first.
- **Integrate** — a Cycloid-style form over a HoBo Bindle kind is a coherent product idea.
- **Benchmark** on developer friction: the form sets the bar for how little a developer should need
  to know.
- Not a displace, adopt, provider, or render target.

## Threats and lessons

1. **HoBo loses demos it should win.** Two visible surfaces — live cost feedback and a
   self-maintaining topology view — do more to convince a buyer than a portability argument. Both
   are *not-present* in HoBo and both are within reach given what the control plane already knows.
2. **Fourth independent recurrence of the topology-view gap** in this cohort (Massdriver's canvas,
   OpenChoreo's cell diagrams, InfraView here, plus Mia-Platform's catalog). That is no longer a
   nice-to-have; it should be its own implementation issue.
3. **Cost belongs in the authoring loop, not only in the matching engine.** HoBo's differentiator is
   that cost *decides*; that is worth nothing to a user who cannot see it. Surfacing the scored
   cost of each candidate at plan time is the missing half.
4. **Carbon-aware placement is an open flank.** GreenOps exists commercially; nothing in this corpus
   makes carbon an input to a placement *decision*. HoBo's scoring model could, cheaply.

Product gaps recorded here (cost surfaced at authoring/plan time; generated topology view;
carbon as a matching input) belong in their own implementation issues, per the research contract.

## Sources

- [InfraView](https://www.cycloid.io/product/infraview/) — auto-generated topology from Terraform source, multi-cloud coverage including OpenStack and Flexible Engine
- [TerraCost](https://www.cycloid.io/open-source/terracost/) and [TerraCost feature reference](https://docs.cycloid.io/guide/terracost.html) — open-source cost estimation, integration into Pipelines and StackForms
- [Platform engineering for enterprise](https://www.cycloid.io/platform-engineering-for-enterprise/) — Stacks, StackForms, GitOps-first architecture, open-source foundations (vendor material)
- [Multi-cloud management](https://www.cycloid.io/blog/multi-cloud-management-platform/) and [FinOps solutions](https://www.cycloid.io/solutions/finops-solutions/) — FinOps/GreenOps positioning (vendor material)

Pricing, RBAC depth, and the operational specifics of pipeline execution were not verifiable from
reference documentation in this pass and are not asserted.
