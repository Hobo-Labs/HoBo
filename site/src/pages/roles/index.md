---
layout: ../../layouts/Docs.astro
title: Who writes what
description: "HoBo's division of labor: developers, platform engineers, DevSecOps, SREs, FinOps, and agents-as-users."
---

# Who writes what

HoBo splits cleanly along the lines most teams already have. Each role owns a clear artifact or surface.

| Role | You write / own | The artifact answers |
|---|---|---|
| **[Developers](/HoBo/roles/developers/)** | [Bindles](/HoBo/primitives/bindles/), [Trails](/HoBo/primitives/trails/) | *What is this app, and what does it need?* |
| **[Platform Engineers](/HoBo/roles/platform-engineers/)** | Camps, Yards, Junctions, Matching | *Where may apps live, and how are those places run?* |
| **[DevSecOps](/HoBo/roles/devsecops/)** | Policy packs, guardrails | *What is allowed — and what may cross a border?* |
| **[SREs](/HoBo/roles/sre/)** | Runbooks, SLOs | *How do we detect, diagnose, and safely fix?* |
| **[FinOps](/HoBo/roles/finops/)** | Budgets, showback expectations | *What does it cost, and is the move worth it?* |
| **[Agents](/HoBo/agents/)** | Scoped tasks via SDK/CLI/MCP | *What can an autonomous principal do under policy?* |

Credentials and audit trails are **not** role docs — see [Security → Agent credentials](/HoBo/security/credentials/) and [Observability → Agent audit](/HoBo/observability/agent-audit/).

## Related

[Operations](/HoBo/operations/) · [The Crew (custom ACP)](/HoBo/crew/) · [MCP](/HoBo/agents/mcp/)
