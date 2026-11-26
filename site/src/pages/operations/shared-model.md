---
layout: ../../layouts/Docs.astro
title: Crew shared model
description: "How every Crew operator shares identity, policy, events, MCP, engines-behind-ports, and handoff protocols."
---

# Crew shared model

## Identity & policy

- Each operator is a **principal** with workload identity and short-lived brokered credentials.
- Actions are deny-by-default RBAC on `hobo:*` control-plane verbs.
- Mandatory org policy is a **deny ceiling** — operators cannot widen what policy denies.
- Credential audit answers: *what did this operator access, with which token, when?*

## Event families

| Family | Use |
|---|---|
| `crew.*` | Roster-level: dispatched, proposed, applied/denied, handoff |
| `run.*` | Durable agent run lifecycle |
| Domain families | `incident.*`, `pipeline.*`, `deployment.*`, `gen.*`, … |

**No per-agent event silos.** Remediation facts stay on domain streams.

## Engines behind ports

| Concern | Default | Optional swap |
|---|---|---|
| SRE reasoning | Built-in | HolmesGPT adapter |
| Runbooks | Pipelines engine | StackStorm-class engines |
| Coding | Built-in / configured coding agent | External coding engine port |
| UI generation | `ui-render` adapters | OpenUI / json-render / mcp-apps |
| Cost advice | Built-in FinX projections | External recommender port |

Swapping an engine is per-Yard config; the deterministic core (events, gates, RBAC) stays.

## Decision pattern

1. Observe signal (projection, alert, burn, drift, gate fail).
2. Dispatch operator (`crew.AgentDispatched`).
3. Propose action + blast radius (`crew.ActionProposed`).
4. Policy decides (`policy.Decided`) → apply or deny (`crew.ActionApplied` / `ActionDenied`).
5. Escalate via `crew.HandoffRequested` (agent→agent or agent→human / A2H).

## Integration ports

Crew drives:

- **`issue-tracker`** — JIRA / GitHub Issues / Linear
- **`knowledge`** — Confluence / Obsidian / Wikis (runbooks, postmortems-by-replay)

Writes ride `crew.ActionApplied` + `policy.Decided`.

## Guardrails

Jailbreak/PII-laden prompts → `guardrail.Blocked` + `policy.Decided`, replayable. Operators stay sandboxed under AI governance.

## Related operator pages

[SRE](/HoBo/operations/sre/) · [Endpoint Monitor](/HoBo/operations/endpoint-monitor/) · [GitOps](/HoBo/operations/gitops/) · [Platform Engineer](/HoBo/operations/platform-engineer/) · [SWE](/HoBo/operations/swe/) · [UX Designer](/HoBo/operations/ux-designer/) · [FinOps](/HoBo/operations/finops/)
