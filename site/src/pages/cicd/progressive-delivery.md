---
layout: ../../layouts/Docs.astro
title: Progressive delivery
description: "Harness flags, experiments, gateway weights, sandbox lanes, and safe cutover composed with Trails and Gatekeeper."
---

# Progressive delivery

Progressive delivery is how HoBo shifts **traffic, flags, and contract observation** without treating every change as a big-bang deploy.

## Building blocks

| Block | Role |
|---|---|
| **Harness flags** | Ranked evaluation with audit facts |
| **Experiments** | Bounded exposure |
| **Gateway weights** | Split traffic across revisions/camps |
| **Sandbox lanes** | Isolate experimental observations |
| **Trails** | Multi-step cutover recipes when infra + data move together |
| **Gatekeeper** | Still admits infra mutations |

## Safe defaults

1. Baseline contracts ignore sandbox-lane events.
2. Flag and weight changes are **events** — replayable.
3. Auto-rollback hooks pair with canary live-fix (Crew SRE path).
4. Prod writes often `require-approval` under policy packs.

## CLI

- `hobo feature …` — flags / progressive ops 
- `hobo trails plan|status|inspect` — recipe observation 
- `hobo inspect` — projections and time-travel 

## Testing

Shadow Bridge mode, dual fixtures (flag on/off), and chaos partial shifts. See [Harness reference](/HoBo/reference/harness/) · [Bridge modes](/HoBo/testing/bridge-modes/).

## Related

[Continuous migration](/HoBo/cicd/migration/) · [Trails](/HoBo/primitives/trails/) · [Crew SRE](/HoBo/operations/sre/)
