---
layout: ../../layouts/Docs.astro
title: Endpoint Monitor
description: "Crew Endpoint Monitor: continuous synthetics, health/SLO watch, and drift signals that feed the SRE operator."
---

# Endpoint Monitor

**Mission:** synthetic probes, health/SLO watch, drift surfacing — the eyes that feed remediation.

## What it does

- Continuously probes camp endpoints and critical user journeys.
- Emits burn/alert/drift signals (`slo.BudgetBurned`, `alert.*`, drift facts).
- **Does not** own remediation — it **feeds the SRE**.

## Why separate from SRE

Separation of observation and action keeps blast radius honest: monitors stay autonomous; fixes stay policy-gated. A noisy probe cannot silently rewrite production without the SRE decision tree and Gatekeeper/policy path.

## Engine

External synthetic-check providers sit behind a port; built-in probing is the default. Swappable per Yard.

## Events & consumers

| Emits | Consumed by |
|---|---|
| SLO burn / alert / drift | SRE operator, dashboards, status page pipeline |
| Credential audit on probes | Security review |

## Testing angle

Availability tests in CI often **replay** historical burn/resolution sequences rather than paging production. Live synthetics belong in real camps; see [Chaos & availability](/HoBo/testing/chaos/).

## Related

[SRE](/HoBo/operations/sre/) · [Shared model](/HoBo/operations/shared-model/)
