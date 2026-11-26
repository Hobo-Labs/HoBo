---
layout: ../../layouts/Docs.astro
title: HoBo for SREs
description: "Event-sourced ops, synthetics, runbooks, Crew SRE, chaos practice, and gated remediation."
---

# HoBo for SREs

You care about **MTTR, error budgets, and change safety**. HoBo makes the control and data planes replayable so “what happened?” is a query.

## Daily tools

| Tool | Use |
|---|---|
| `hobo inspect` | Time-travel deployments/runs |
| `hobo logs` | Streamer live-tail |
| `hobo incident` / `runbook` | Disposition + gated fix |
| Endpoint Monitor | SLO burn signals |
| SRE Crew | Diagnose + propose; policy gates writes |
| Chaos tests | Session faults, shadow, synthetics |

## Mindset shifts

- Audit = event log, not ticket archaeology 
- Remediation is often canary + auto-rollback 
- Prod writes frequently require-approval 
- Never retry policy denials as “healing” 

## Related

[Crew SRE](/HoBo/operations/sre/) · [Observability](/HoBo/observability/) · [Chaos testing](/HoBo/testing/chaos/) · [Runbooks](/HoBo/operations/runbooks/) · [CI host health](/HoBo/ci/host-health/)
