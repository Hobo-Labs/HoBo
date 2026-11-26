---
layout: ../../layouts/Docs.astro
title: Runbooks
description: "Declarative trigger → diagnose → gated fix runbooks; event-sourced execution via hobo runbook."
---

# Runbooks

Runbooks encode operational knowledge as **data**: trigger → diagnose → gated fix. Execution is event-sourced; write actions still pass policy obligations.

## Properties

| Property | Detail |
|---|---|
| Declarative | Steps and gates, not opaque scripts only |
| Replayable | What ran is in the log |
| Policy-gated | Prod fixes often require-approval |
| CLI | `hobo runbook` execute / replay |

## Relation to SRE Crew

SRE may select and execute runbooks during incidents. Custom engines can propose runbook steps; they cannot skip Gatekeeper.

## Related

[SRE](/HoBo/operations/sre/) · [CLI](/HoBo/reference/cli/) · [Incidents in shared model](/HoBo/operations/shared-model/)
