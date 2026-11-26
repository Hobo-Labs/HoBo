---
layout: ../../layouts/Docs.astro
title: Metering
description: "Usage facts, dimensions, metering bus/sinks, showback projections, ranking vs billing, and FinOps advisory boundaries."
---

# Metering

Metering turns **replayable facts** into usage evidence for showback, FinOps projections, dispute support, and ranking — **not** silent invoice invention.

## Model

1. Workloads and control plane emit usage-related facts (`meter.UsageRecorded` and related; also derived from `run.*`, `deployment.*`, `resource.*`, `gen.*`).
2. A **metering bus** fans out to sinks (in-process, export, warehouse adapters).
3. FinOps views (showback, anomalies, forecasts) are **projections** over facts.
4. Humans and the FinOps Crew **advise**; breakers, tiers, and policy **enforce**.

## Dimension matrix (required for M0 contracts)

| Dimension | Why |
|---|---|
| Tenant | Showback isolation + support lookup |
| Workspace / Project | Customer grouping and policy reconciliation |
| Environment | Prod vs preview vs test separation |
| Camp / Bindle | Operational and package grouping |
| Run / Agent | Runtime + AI attribution and dispute lineage |
| Team | Org-level reporting |

## Fact classes (examples)

| Class | Typical family | Sensitive? |
|---|---|---|
| Control-plane operation | `deployment.*` | No |
| Runtime compute | `run.*` | No |
| Storage / egress | `resource.*` | No |
| Generation run | `gen.*` | Often yes |
| Support adjustment | `meter.*` | Yes |

Sensitive classes require redaction/retention rules before customer export.

## Legal / ranking hygiene

- Third-party **price and free-tier** facts are **ranking input** with source URL + human-checked date — never fabricated “vendor signed” attestations.
- Free-tier headroom is **never pooled** across tenants.
- Rotation is **across providers**, never across accounts within a provider to reset free tiers.
- Metering/billing data stays **tenant-scoped**.

## FinOps Crew

The FinOps operator agent reads metering projections, flags anomalies, and proposes commitment/move advice. It does **not** auto-spend or auto-destroy. See [FinOps Crew](/HoBo/operations/finops/).

## Related

[Policy](/HoBo/reference/policy/) · [FinOps role](/HoBo/roles/finops/) · [Security](/HoBo/security/)
