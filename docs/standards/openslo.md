---
type: Reference Standard
title: "OpenSLO"
description: "OpenSLO is \"an open specification for defining and expressing service level objectives (SLO).\" It is a **declarative YAML language** — Kubernetes-style `apiVersion`/`kind`/`metadat"
tags: [hobo, standards]
---

# OpenSLO

> **Standard** · Open, vendor-neutral YAML specification for declaring Service Level Objectives as code. Source: [openslo.com](https://openslo.com/) · [OpenSLO/OpenSLO (spec)](https://github.com/OpenSLO/OpenSLO) · [Nobl9 docs](https://docs.nobl9.com/slos-as-code/openSLO). Excerpts quoted for analysis (fair use).

## What it is
OpenSLO is "an open specification for defining and expressing service level objectives (SLO)." It is a **declarative YAML language** — Kubernetes-style `apiVersion`/`kind`/`metadata`/`spec` objects — for capturing **SLOs, the SLIs that measure them, error budgets, time windows, budgeting methods, and alerting policies** as version-controllable, tool-agnostic artifacts. The intent is "SLOs as code": one portable definition that any conforming backend (Nobl9, Sloth, Pyrra, etc.) can consume, rather than each observability vendor inventing its own SLO config.

`apiVersion` is **`openslo/v1`**.

## Key features
- **Object kinds** (each a discrete YAML document):
  - **`SLO`** — the target itself: a service level's target value/range described by an SLI, with `objectives`, a `timeWindow`, a `budgetingMethod`, and optional `alertPolicies`.
  - **`SLI`** — Service Level Indicator: how to read the metric, either a **`thresholdMetric`** (single query, good below/above a threshold) or a **`ratioMetric`** (`good`/`bad` ÷ `total`, with `counter`).
  - **`Service`** — "a high-level grouping of SLO"; SLOs reference it.
  - **`DataSource`** — reusable connection details for a metric source (e.g. Prometheus, Datadog), keeping queries DRY and credentials separate.
  - **`AlertPolicy`** — binds `AlertCondition`s to `AlertNotificationTarget`s; says *when* to alert.
  - **`AlertCondition`** — the trigger: typically a **burn-rate** threshold over a **lookback window** (`condition` with `kind: burnrate`, `threshold`, `lookbackWindow`).
  - **`AlertNotificationTarget`** — the delivery destination (email, Slack, webhook, PagerDuty, …).
- **Budgeting methods** (how the error budget is consumed):
  - **`Occurrences`** — ratio of count of good events to total count of events.
  - **`Timeslices`** — ratio of good time slices to total time slices in the period.
  - **`RatioTimeslices`** — average of all time slices' success ratios over the period.
- **Time windows** (exactly one per SLO):
  - **Rolling** — a moving `duration` (e.g. `28d`, `4w`) with `isRolling: true`; budget continuously recovers as breaches roll out — good for fast detection/reaction.
  - **Calendar-aligned** — fixed `duration` (`1M`, `1Q`, `1Y`) anchored to a `calendar` start + timezone (`isRolling: false`) — good for reporting aligned to business cycles.
- **Objectives** — fields include `displayName`, `target`/`targetPercent` (e.g. `0.99`), `op` + `value` (the threshold comparison), `indicator`/`indicatorRef` (inline or referenced SLI), `timeSliceTarget`/`timeSliceWindow` (for time-slice methods), and `compositeWeight` (composite SLOs).
- **Error budget** — derived from `target`: the allowable failure quota over the window (e.g. a 99.9% target over 30d ≈ 43m of budget). The budget **burns** as the SLI underperforms; **burn-rate** alerts (multiwindow/multi-burn-rate) fire before exhaustion.
- **Composite SLOs** — combine multiple objectives; the composite budget burns if any constituent objective's budget burns.

Example:
```yaml
apiVersion: openslo/v1
kind: SLO
metadata: { name: api-availability }
spec:
  service: payment-api
  indicator:
    spec:
      ratioMetric:
        counter: true
        good:  { metricSource: { type: Prometheus, spec: { query: 'sum(rate(http_requests_total{code=~"2..|3.."}[5m]))' } } }
        total: { metricSource: { type: Prometheus, spec: { query: 'sum(rate(http_requests_total[5m]))' } } }
  timeWindow: [ { duration: 30d, isRolling: true } ]
  budgetingMethod: Occurrences
  objectives: [ { displayName: HA, target: 0.99 } ]
```

## Relevance to HoBo
HoBo already has SLOs in two places: **committed NFR baselines** in [ADR-0021](../design/adr/07-portability-extensibility.md#adr-0021) (control-plane availability 99.9%/99.95%, deploy-resume < 30s, RTO < 15m, determinism as a hard invariant) and **built-in SLOs with burn-rate alerts** in [Plan 14 §SLOs & alerting](../design/reliability-observability-cost.md#plan-05). Today those are prose + tables. OpenSLO is the natural way to make them **machine-readable, declarable-by-the-developer, and gate-able**.

**The case for adopting OpenSLO as HoBo's SLO interchange format:**
- **SLOs as a first-class declared resource.** A developer should be able to declare an OpenSLO `SLO` next to their Bindle (the `service`/`web` resource), and HoBo treats it as part of the runtime/SLO contract surface in [Plan 29](../design/contracts-policy-flags.md#plan-29). OpenSLO's `Service`/`SLO`/`SLI` model maps cleanly onto HoBo resources, and its `DataSource` maps onto HoBo's OTel/metrics pipeline ([Plan 5](../design/reliability-observability-cost.md#plan-05)).
- **SLO-gated deploys (`can-deploy`).** HoBo already gates on `compat.GatePassed`/`compat.GateFailed` ([Plan 29](../design/contracts-policy-flags.md#plan-29)) and `policy.Decided` ([Plan 29](../design/contracts-policy-flags.md#plan-29)). An OpenSLO objective with a healthy error budget becomes a **deploy gate dimension**: if the error budget is already exhausted, the policy plane can deny or require-approval on a risky deploy — the SRE "freeze releases when out of budget" practice, expressed as code.
- **Error-budget-driven canary rollback.** [Plan 5 §Deployment strategies](../design/reliability-observability-cost.md#plan-05) defines canary/progressive rollouts whose health gate is "a `step` with a timeout and a rollback compensation," fed by data-plane health signals. An **OpenSLO `AlertCondition` (burn-rate)** is exactly the right signal function for that gate: a fast-burn breach during canary soak triggers **auto-rollback** through the existing gated-saga machinery; the decision rides `policy.Decided`. This also generalizes the AI **live-fix** trigger ("a failing trace or SLO/health breach," [Plan 5 §v2](../design/reliability-observability-cost.md#plan-05)/[Plan 23](../design/generated-stack.md#plan-23)).
- **Burn-rate alerts route through AlertManager.** OpenSLO defines *what* burns; the *routing/grouping/silencing* of the resulting alert is AlertManager's job — see [`../technologies/prometheus-alertmanager.md`](../technologies/prometheus-alertmanager.md). OpenSLO's `AlertNotificationTarget` and AlertManager's receivers are the same concern at two layers.

**Boundaries / caveats.** OpenSLO covers *application/service* SLOs well, but HoBo's NFR baselines ([ADR-0021](../design/adr/07-portability-extensibility.md#adr-0021)) include platform-internal invariants (e.g. *determinism: `replay == live state`*, RTO from log replay) that aren't time-series SLIs and don't fit the OpenSLO ratio/threshold model — those stay as verification fixtures, not OpenSLO objects. So the recommendation is: **adopt OpenSLO for the developer-facing and service-level SLOs (and as the input to deploy gates + canary rollback), keep the platform invariants as test gates.** Like other capability standards, the OpenSLO *evaluator* (Nobl9/Sloth/Pyrra) is a candidate to sit **behind a HoBo port**, with HoBo owning the declaration format and the gate/rollback semantics.

## Sources
- [OpenSLO — openslo.com](https://openslo.com/)
- [OpenSLO/OpenSLO — specification repository](https://github.com/OpenSLO/OpenSLO)
- [OpenSLO support — Nobl9 docs](https://docs.nobl9.com/slos-as-code/openSLO)
- [Nobl9 — Error budgets, SLOs, SLIs & SLAs](https://www.nobl9.com/resources/a-complete-guide-to-error-budgets-setting-up-slos-slis-and-slas-to-maintain-reliability)
- HoBo: [ADR-0021 — NFR baselines / SLOs](../design/adr/07-portability-extensibility.md#adr-0021) · [Plan 14 — Observability](../design/reliability-observability-cost.md#plan-05) · [Plan 5 — Reliability/HA](../design/reliability-observability-cost.md#plan-05) · [Plan 29 — Contracts & compatibility](../design/contracts-policy-flags.md#plan-29) · [Plan 30 — Policy plane](../design/contracts-policy-flags.md#plan-29)
