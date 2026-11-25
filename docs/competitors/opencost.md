---
type: Competitive Reference
title: "OpenCost — Competitor Reference"
description: "The vendor-neutral CNCF specification for Kubernetes cost allocation — a standard to conform to rather than a competitor, and the shape HoBo's showback export already targets."
tags: [hobo, competitors]
competitor:
  slug: opencost
  name: "OpenCost"
  aliases: ["open cost"]
  primary_category: finops-governance-placement
  categories: [finops-governance-placement]
  directness: complementary
  role: "the cost-allocation standard — a specification HoBo conforms to, and the reason HoBo's non-Kubernetes metering needs an equivalently precise definition"
  posture: [standard, integrate, borrow]
  hobo_surface: [finops, observability]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  sources:
    - https://opencost.io/docs/specification/
    - https://opencost.io/
    - https://www.cncf.io/projects/opencost/
---

# OpenCost — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**. Read alongside [Kubecost](kubecost.md), the commercial product built
> on this core. Supersedes the OpenCost portion of the
> [FinOps tooling cohort capture](finops-tooling.md).

## What it is

OpenCost is a **vendor-neutral open-source specification and implementation for Kubernetes cost
monitoring**, a CNCF project. It is the closest thing this category has to a standard, and treating
it as a competitor would be a category error — it is a definition HoBo should conform to.

- **Product boundary.** It measures and attributes the cost of Kubernetes workloads. It does not
  optimize, enforce, forecast, or deploy.
- **Operating model.** Open source, CNCF Incubating, deployed in-cluster; the specification is
  separately usable by anyone.
- **The differentiator is that it is a specification first.** The value is a *precise, agreed
  definition* of what a workload costs — which is a harder and more useful thing than a dashboard.

## Core primitives and mental model

The specification's decomposition, quoted from
[the spec](https://opencost.io/docs/specification/):

| Primitive | What it is |
| --------- | ---------- |
| **Cluster Asset** | "Observable entities within a Kubernetes cluster that directly incur costs related to their resources. Examples include nodes, persistent volumes, attached disks, and load balancers" |
| **Allocation** | The share of asset cost attributed to a workload over a window |
| **Resource Allocation Cost** | Time-based cost of reserved resources (an hourly CPU rate) |
| **Resource Usage Cost** | Consumption-based cost (data egress) |
| **Cluster Overhead / Idle** | `Cluster Idle Cost = Cluster Asset Costs − Workload Costs` |
| **External Cloud Cost** | Non-cluster provider spend, recommended as "fully Amortized Net Cost" |

Two formulas carry the whole model:

- `Total Cluster Costs = Resource Allocation Costs + Resource Usage Costs + Cluster Overhead Costs`
- Workload cost = **`max(requested resources, actual usage)`** — so that "costs that have been
  directly reserved or allocated by kube-scheduler" are assigned even when consumption is lower.

That `max()` is the most important single decision in the specification. It says **reservation is
consumption for billing purposes**, which is both economically correct and the reason a team's bill
does not fall when their pods idle.

## Feature surface

- Real-time cost allocation by namespace, deployment, label, pod and container.
- CPU, memory, GPU, storage, load-balancer and network attribution.
- Idle-cost computation and shared-cost distribution — "uniformly across tenants, proportionally to
  consumption, or via custom metrics".
- Cloud billing reconciliation against provider price data, with amortized net cost as the
  recommended basis.
- Prometheus-based metrics and an HTTP allocation API.
- Multi-cloud price tables for the major providers.
- A written specification independent of the implementation.

## Architecture

- **Control plane** — a single in-cluster component reading kube-state and Prometheus metrics,
  joined against cloud price data.
- **Data model** — assets carry cost; allocations distribute it; idle is the residual. The residual
  design is what makes the numbers reconcile to the bill, which is the property FinOps teams
  actually check.
- **State authority** — the cloud bill, reconciled; metrics supply the distribution.
- **Extension model** — custom pricing configuration and shared-cost weighting.
- **Portability boundary** — the *implementation* assumes Kubernetes and Prometheus. The
  *specification* is more portable than that, and its vocabulary transfers to any system that can
  identify assets and attribute them.

## How it competes with HoBo

It does not. This capture exists because HoBo's showback design already models itself on this shape
([ADR-0039](../design/adr/02-identity-security.md#adr-0039) §3,
[FOCUS/OpenCost standard note](../standards/focus-opencost.md)).

| Contested HoBo surface | The relationship |
| ---------------------- | ---------------- |
| `finops` | A conformance target for HoBo's metering export, not a rival |
| `observability` | Allocation metrics HoBo can consume where a cluster is a deployment target |

## Primitive mapping

| OpenCost | Nearest HoBo concept | Honest correspondence |
| -------- | -------------------- | --------------------- |
| Cluster Asset | Provider resource in a Camp | Close in role; HoBo's assets are heterogeneous and not all metered per-hour. |
| Allocation | `MeteringView` attribution by tenant/project/Camp/Bindle/run | **Close by design** — HoBo's export targets this shape. |
| `max(requested, usage)` | — | **HoBo has no equivalent rule stated for non-Kubernetes workloads.** This is the gap. |
| Idle as residual | — | HoBo has no idle-cost concept; for serverless and wasm targets there may be none, which is a claim that needs stating rather than assuming. |
| Shared-cost distribution | Showback weighting | Partial; HoBo has not specified the weighting options. |
| Amortized net cost | `FocusCostLedgerEntry` | Close; both defer to the provider bill as truth. |
| — | Cost-aware placement (ADR-0071) | **No equivalent.** OpenCost measures; it never chooses. |

## Where OpenCost is stronger

- **It is a specification, not a product.** The definitions are written down, reviewed, and agreed
  across vendors — which is why every other tool in this category either implements or exports it.
- **The reconciliation property.** Allocation plus idle equals the bill. Cost tools that do not
  reconcile get abandoned the first time finance checks them, and this design makes reconciliation
  structural rather than aspirational.
- **`max(requested, usage)` is the right rule** and is stated plainly, which spares every downstream
  implementer an argument.
- **Vendor neutrality with CNCF governance**, meaning conformance is a credible claim rather than
  compatibility with one vendor.
- **Maturity of the Kubernetes attribution problem** — GPU, storage, network and shared costs are all
  handled, and each was a real edge case someone hit.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Cost at plan time** (*design-only*, [Plan 5](../design/reliability-observability-cost.md#plan-05)).
  OpenCost is strictly retrospective; it cannot tell you what a change will cost.
- **Cost-aware placement** (*design-only*, [ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
  Measurement never becomes a decision here.
- **Enforcement** (*design-only*, ADR-0039 §2 budgets and spend caps). OpenCost reports; it does not
  gate.
- **Heterogeneous attribution** (*design-only*). HoBo must attribute wasm, serverless and managed
  services, none of which have a node to divide.
- **Honest caveat.** OpenCost's Kubernetes attribution is complete and battle-tested; HoBo's
  equivalent for its own targets is designed and not proven, and the `max()` rule has no stated
  analogue for a serverless invocation.

## Adversarial critique

- **Kubernetes-only in practice.** The specification generalizes; the implementation does not. Half a
  modern estate is managed services OpenCost sees only as an external cloud cost line.
- **Accuracy depends on price data that is hard to get right.** Discounts, commitments, spot pricing
  and enterprise agreements make list-price attribution wrong, and reconciliation to the bill fixes
  the total without fixing the distribution.
- **Prometheus dependency** ties cost fidelity to metrics retention, so historical accuracy degrades
  exactly when someone wants to investigate a spike from last quarter.
- **Idle is computed, not owned.** Knowing the cluster is 40% idle does not tell anyone whose
  fault it is, and the shared-cost weighting choice is a political decision the tool cannot make.
- **The specification is a floor.** Everything commercially interesting — recommendations, anomaly
  detection, forecasting, multi-cluster federation — sits above it, which is the business model of
  the product built on top.
- **Measurement without enforcement changes little.** A dashboard showing waste is a well-understood
  organizational non-event; this criticism applies to the entire category and OpenCost most purely.

## Better-together / integration posture

- **Standard** — the primary posture. HoBo's metering export should be OpenCost-shaped, and should
  say so.
- **Integrate** — where a HoBo placement resolves to a cluster, OpenCost is the right source for
  allocation data rather than a second metering path.
- **Borrow** — two things:
  1. **`max(requested, usage)` as an explicitly stated rule.** HoBo needs an equally explicit
     statement for each target class it meters, including the case where it is `usage` alone.
  2. **Idle as a residual that makes the numbers reconcile.** Whatever HoBo reports must add up to
     the provider bill, and designing for that up front is much cheaper than retrofitting it.
- Not a displace, adopt or provider target.

## Threats and lessons

1. **A precise definition is a moat.** OpenCost won this category by writing down what a pod costs.
   HoBo's claim to meter heterogeneous targets needs the same treatment: a written rule per target
   class, not an implementation.
2. **Reconciliation to the bill is the acceptance test.** Any HoBo cost surface that does not sum to
   the provider invoice will be disbelieved, correctly, on first contact with finance.
3. **Conformance is cheaper than competition.** Exporting an OpenCost-shaped allocation makes HoBo
   legible to every FinOps tool a customer already runs, which is a far better position than asking
   them to look at another dashboard.
4. **The non-Kubernetes gap is real and is HoBo's opening.** OpenCost has no answer for a managed
   database or a wasm module. HoBo's provider-abstract model is the natural place for a unified
   attribution story — and that is currently a design claim, not an implemented one.

## Sources

- [OpenCost specification](https://opencost.io/docs/specification/) — asset/allocation model, cost formulas, `max(requested, usage)`, idle as residual, amortized net cost (quoted above)
- [opencost.io](https://opencost.io/) — project scope and implementation
- [CNCF project page](https://www.cncf.io/projects/opencost/) — governance and maturity level
- Related: [Kubecost](kubecost.md) for the commercial product on this core, [Infracost](infracost.md) for the plan-time counterpart, and HoBo's [FOCUS/OpenCost standard note](../standards/focus-opencost.md)

Current CNCF maturity level, price-table coverage and GPU attribution fidelity were not verified in
this pass and are not asserted.
