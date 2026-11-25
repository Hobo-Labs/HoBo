---
type: Competitive Reference
title: "FinOps tooling landscape — Competitor Reference"
description: "Superseded cohort capture: OpenCost, Kubecost, Infracost, Vantage and CAST AI now have canonical per-product captures. This page is the cohort's cross-product reading."
tags: [hobo, competitors]
competitor:
  slug: finops-tooling
  name: "FinOps tooling cohort"
  aliases: ["kubecost cohort"]
  primary_category: finops-governance-placement
  categories: [finops-governance-placement]
  directness: adjacent
  role: "superseded cohort pointer — per-product captures are canonical; this page retains only the cross-product reading"
  posture: [benchmark, integrate]
  hobo_surface: [finops, governance, provider-matching]
  evidence: mixed
  status: archived
  research_date: 2026-08-20
  sources:
    - https://www.kubecost.com/
    - https://opencost.io/
---

# FinOps tooling landscape — Competitor Reference

> **Superseded.** Each product in this cohort now has a canonical capture under the HoBo Competitive
> Research Contract. This page is kept for the cross-product reading only; per-product research lives
> in the captures below, and any conflict between this page and one of them is resolved in the
> capture's favour.

## Canonical captures

| Product | Capture | Its distinct contribution |
| ------- | ------- | ------------------------- |
| **OpenCost** | [`opencost.md`](opencost.md) | The vendor-neutral allocation *specification* — a standard to conform to, not a competitor |
| **Kubecost** | [`kubecost.md`](kubecost.md) | The commercial layer above that standard: recommendations, alerts, federation |
| **Infracost** | [`infracost.md`](infracost.md) | Cost at **plan time**, in the pull request — before the money is committed |
| **Vantage** | [`vantage.md`](vantage.md) | Multi-cloud aggregation, and virtual tagging as retroactive attribution |
| **CAST AI** | [`cast-ai.md`](cast-ai.md) | The only one that **acts**: rightsizing, bin packing, spot orchestration |

## The cross-product reading

Four of the five report; one acts. That is the shape of the category, and it is the finding HoBo
should design against.

- **Measurement is a commodity.** OpenCost made allocation free and standardized, so no HoBo
  advantage can rest on measuring better. HoBo should conform and export, not compete
  ([FOCUS/OpenCost standard note](../standards/focus-opencost.md)).
- **Nothing here enforces.** Every budget in this cohort notifies after the fact. An admission-time
  spend cap ([ADR-0039](../design/adr/02-identity-security.md#adr-0039) §2) is a genuinely
  differentiated claim — and is designed, not shipped.
- **Nothing here places.** Cost never becomes an input to *where a workload runs*
  ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)); CAST AI comes closest and is confined
  to node shape within one cluster.
- **Nothing here closes the loop.** No product compares its own estimate to the actual bill for the
  same workload. HoBo holds both sides in one event log (ADR-0135) and this remains the cohort's
  clearest unclaimed feature.
- **Someone must own the price data.** Cost-aware placement depends on accurate multi-provider
  pricing — the asset both Infracost and Vantage built businesses around, and which HoBo's design
  currently treats as free.
- **Kubernetes is not where the money is.** Four of the five are cluster-scoped or IaC-scoped, while
  managed services and egress dominate real bills. HoBo's provider-abstract model is the natural home
  for unified attribution, and that is a design claim rather than an implemented one.
- **Automation needs a declared risk budget.** CAST AI's spot and bin-packing automation is safe only
  against a workload that has stated what it tolerates — external support for `ResilienceProfile`
  living on the contract ([ADR-0136](../design/adr/03-data-plane-effects-resiliency.md)).

## Where this leaves HoBo

HoBo meters only what it deployed, which is a minority of any real bill. The honest position is
**authoritative for HoBo-managed spend, integrable for the rest** — not "a FinOps platform". The
differentiators worth arguing are enforcement at admission, cost as a placement input, residency-aware
optimization, and estimate-versus-actual from a single event log. All four are design-stage.

## Sources

Per-product sources are recorded in the canonical captures linked above.
