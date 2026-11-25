---
type: Reference Standard
title: "FOCUS & OpenCost"
description: "FOCUS (FinOps Open Cost and Usage Specification) is a normalized column taxonomy for cost and usage data across cloud providers; OpenCost is the CNCF cost-allocation specification and reference implementation for attributing infrastructure spend to workloads."
tags: [hobo, standards]
---

# FOCUS & OpenCost

> **Standards** · Normalized cost/usage billing-data spec (FOCUS) + CNCF cost-allocation spec (OpenCost). Sources: [focus.finops.org](https://focus.finops.org/what-is-focus/) · [OpenCost](https://opencost.io/) · [FinOps Framework](https://www.finops.org/framework/). Excerpts quoted for analysis (fair use).

## What it is

HoBo's FinOps boundary adopts two complementary open standards together:

- **FOCUS** (FinOps Open Cost and Usage Specification) — a **vendor-neutral column taxonomy** for cost and usage records. FOCUS defines canonical field names, types, and semantics so billing/usage exports from AWS, Azure, GCP, OCI, and SaaS vendors can be normalized into one schema for allocation, showback, forecasting, and anomaly detection.
- **OpenCost** — a **CNCF cost-allocation specification** (and reference implementation) for attributing infrastructure cost to Kubernetes workloads. OpenCost defines how usage metrics combine with price tables to produce allocation dimensions (namespace, deployment, label), how idle and shared cluster cost is distributed, and a query/API surface for cost visibility.

**Why one note covers both:** [ADR-0039](../design/adr/02-identity-security.md#adr-0039) §3 models showback on the **OpenCost allocation shape** while the [FinOps budget-routing control plane](../design/finops-budget-routing-control-plane.md#standards-baseline) baselines **FOCUS 1.4** for normalized actual-cost ledgers. The data format (FOCUS) and the allocation method (OpenCost) are adopted as a pair at HoBo's FinOps boundary.

## Key features

### FOCUS 1.4

- **Core cost columns:** `BilledCost`, `EffectiveCost`, `ListCost`, `ContractedCost` — distinguish list vs negotiated vs amortized vs cash-basis figures; HoBo's `CreditLedgerView` effective marginal cost ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) aligns with the EffectiveCost vs ListCost distinction.
- **Charge categories & dimensions:** SKU, pricing unit, service category, resource ID, region, account/subscription, tags/labels — the normalized vocabulary for multi-cloud rollups.
- **Provider adoption:** AWS CUR export mappings, Azure Cost Management, GCP BigQuery billing export, OCI cost reports — FOCUS is the interchange layer above provider-native shapes.
- **1.4 additions:** richer commitment/discount/amortization columns and clearer guidance for shared-cost attribution — relevant to HoBo's showback over pooled Camp/Bindle resources.

### OpenCost allocation spec

- **Allocation formula:** cost = usage × unit price per resource dimension (CPU, memory, GPU, network, storage).
- **Idle cost:** cluster overhead not attributable to a running pod is tracked separately and distributed by configurable rules.
- **Shared cost:** cross-namespace infrastructure (control plane, monitoring, ingress) allocated by proportion or fixed weights.
- **API surface:** Prometheus-compatible metrics + REST allocation queries; Kubecost extends OpenCost with enterprise UI, savings insights, and multi-cluster federation.
- **Relationship to Kubecost:** OpenCost is the open-core allocation engine; Kubecost commercializes dashboards, alerts, and recommendations on top.

### FinOps Framework

The [FinOps Framework](https://www.finops.org/framework/) defines **Inform / Optimize / Operate** phases and capability vocabulary (budgeting, forecasting, allocation, anomaly management, rate optimization, workload optimization). The [FinOps budget-routing control plane](../design/finops-budget-routing-control-plane.md#standards-baseline) baselines this vocabulary for FinX surfaces (budgets, forecasts, attribution, anomaly signals, commitments, optimization recommendations) without importing a specific vendor product.

## Relevance to HoBo

**MeteringView dimensions vs FOCUS columns.** [ADR-0039](../design/adr/02-identity-security.md#adr-0039) §1 folds five metered quantities — control-plane operations, runtime compute-seconds, storage-GB, egress-GB, generation runs — from the event log into a `MeteringView`. FOCUS columns provide the export vocabulary when those quantities are surfaced as showback or imported from provider billing: HoBo's internal dimensions map onto FOCUS service/resource/tag fields at the boundary.

**Showback modeled on OpenCost.** ADR-0039 §3 attributes cost by tenant → project → Camp → Bindle → run/agent/team (and `app-tenant` for multi-tenant apps) and states showback is **modeled on the OpenCost open standard** so figures are portable to existing FinOps tooling. The allocation-spec shape (usage × price, idle/shared distribution rules) is the contract even when the runtime is wasm-first rather than Kubernetes-native.

**Effective marginal cost vs FOCUS cost types.** [ADR-0071](../design/adr/01-architecture-core.md#adr-0071) `CreditLedgerView` derives **effective marginal cost** from free-tier headroom, promo credits, and budget caps — the runtime analogue of FOCUS `EffectiveCost` vs `ListCost`. Dispatcher routing ranks providers by this effective cost, not list price alone.

**Standards baseline and export.** The [FinOps budget-routing control plane](../design/finops-budget-routing-control-plane.md#standards-baseline) records FOCUS 1.4 for normalized actual-cost ledgers and the FinOps Framework for operating-model vocabulary. `FocusCostLedgerEntry` and related proof fixtures should emit FOCUS-conformant records at the showback export boundary, parallel to CloudEvents/OCSF adoption in [ADR-0046](../design/adr/02-identity-security.md#adr-0046).

**Boundaries / caveats.** FOCUS is a **billing-data format**, but HoBo ships **no billing** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) — showback and quota enforcement only. OpenCost's reference implementation is **Kubernetes-centric**; HoBo's wasm runtime needs its own usage→price mapping (compute-seconds, storage heartbeats, egress counters on events) while keeping the **allocation-spec shape** for interoperability. Anomaly detection, forecasting, and rightsizing recommendations are specified as advisory `cost.*` facts ([ADR-0115](../design/adr/02-identity-security.md#adr-0115)); threshold breakers and degradation tiers still cover reactive cost safety at enforcement time.

## Sources

- [FOCUS — What is FOCUS?](https://focus.finops.org/what-is-focus/)
- [FOCUS specification repository](https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec)
- [OpenCost — opencost.io](https://opencost.io/)
- [OpenCost specification](https://github.com/opencost/opencost)
- [FinOps Framework — finops.org](https://www.finops.org/framework/)
- HoBo: [ADR-0039 — Metering, quota, cost attribution](../design/adr/02-identity-security.md#adr-0039) · [ADR-0071 — Dispatcher / CreditLedgerView](../design/adr/01-architecture-core.md#adr-0071) · [Plan 5 — Cost & FinOps](../design/reliability-observability-cost.md#plan-05) · [FinOps budget-routing control plane — Standards Baseline](../design/finops-budget-routing-control-plane.md#standards-baseline) · [FinOps tooling landscape](../competitors/finops-tooling.md)
