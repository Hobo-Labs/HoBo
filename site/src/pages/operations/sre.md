---
layout: ../../layouts/Docs.astro
title: SRE operator
description: "The Crew SRE: Incident aggregate, diagnose → classify → auto-fix / propose / escalate, runbooks, and postmortem-by-replay."
---

# SRE operator

**Mission:** incident detection → root-cause → **gated remediation**.

The SRE is the Crew member with the deepest product model: it binds alerting/SLO, live-fix, drift + auto-rollback, chaos findings, and pipelines into a governed incident lifecycle.

## Signals in

- `alert.Fired`, `slo.BudgetBurned`
- `resource.DriftDetected`, `compat.GateFailed`
- `spend.CircuitTripped` / cost degradation signals
- golden suite continuous failures

## Incident aggregate

Stream `incident:<id>` — single-writer, rebuildable from the log.

Lifecycle (simplified):

`Opened → Triaged → RootCauseIdentified → RemediationProposed → RemediationApplied|Failed → Resolved → PostmortemFiled` (+ `SLABreached` on MTTD/MTTR overrun).

Multiple alerts fold into **one** incident via correlation/causation IDs — not N pages.

## Decision tree

```text
signal → open Incident
 → diagnose (projections; optional HolmesGPT engine)
 → classify (runtime + contract taxonomy)
 → decide:
 low-risk reversible → auto-fix (canary live-fix + auto-rollback)
 needs review → propose gated Delta/PR
 high-impact/unknown → escalate (on-call / A2H handoff)
 → policy gate always
```

### A2H (agent-to-human)

Escalate with a structured handoff: failing check, proposed fixes, blast radius, decision required. Routed over notify + obligation deadlines. Human apply / re-bless / abort is event-sourced. Security or money-touching goldens marked `requiresHuman` skip auto-fix.

## Runbooks

Trigger → diagnosis steps (MCP queries) → gated fix actions. Runbooks are versioned/signed, event-sourced (`runbook.*`), and built on the pipelines engine. Unmatched fix class → escalate.

## Failure taxonomy (examples)

| Class | Direction |
|---|---|
| Runtime regression | live-fix / rollback |
| Contract skew | shim / deploy-order / migration window |
| Drift | converge / gated repair |
| Cost-induced degradation | shed QoS via costAvailabilityProfile; propose rightsizing |

Unclassifiable → escalate; never silent action.

## SLOs

`sre.mttd` and `sre.mttr` as OpenSLO-style budgets. Burn can freeze risky deploys or deepen postmortem obligations.

## Postmortem

The incident stream **is** the timeline. Blameless postmortem-by-replay; failed remediations become permanent regression tests.

## MCP surface (illustrative)

`diagnose` · `heal` / propose remediation · rides `incident.*` + `policy.Decided`

## Related

[Endpoint Monitor](/HoBo/operations/endpoint-monitor/) (feeds SRE) · [Shared model](/HoBo/operations/shared-model/) · [Chaos testing](/HoBo/testing/chaos/)
