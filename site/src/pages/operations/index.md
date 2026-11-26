---
layout: ../../layouts/Docs.astro
title: Operations
description: "Built-in Yard operator agents: SRE, Endpoint Monitor, GitOps, Platform Engineer, SWE, UX Designer, FinOps — plus handoffs, runbooks, and engines."
---

# Operations

Built-in **Yard operator agents** (the historical “Crew roster”) that detect, diagnose, and **policy-gated** remediate. Custom third-party agents live under [The Crew](/HoBo/crew/) (ACP).

## Roster

| Operator | Mission | Deep dive |
|---|---|---|
| **SRE** | Detect → diagnose → gated remediate | [SRE](/HoBo/operations/sre/) |
| **Endpoint Monitor** | Synthetics, SLO burn, drift | [Endpoint Monitor](/HoBo/operations/endpoint-monitor/) |
| **GitOps** | When/what deploys; promotion | [GitOps](/HoBo/operations/gitops/) |
| **Platform Engineer** | Definitions, packs, policy proposals | [Platform Engineer](/HoBo/operations/platform-engineer/) |
| **SWE** | Implement / refactor / repair app code | [SWE](/HoBo/operations/swe/) |
| **UX Designer** | UI against design.md | [UX Designer](/HoBo/operations/ux-designer/) |
| **FinOps** | Advisory cost & anomalies | [FinOps](/HoBo/operations/finops/) |

Also: [Shared model](/HoBo/operations/shared-model/) · [Handoffs & A2H](/HoBo/operations/handoffs/) · [Runbooks](/HoBo/operations/runbooks/) · [Engines & ports](/HoBo/operations/engines/)

## Guarantees

- Org RBAC — cannot exceed role 
- Event-sourced observations and tool calls 
- MCP tools where applicable 
- Engine behind a port (swappable) 
- Writes policy-gated (often require-approval in prod) 

## Related

[The Crew (custom ACP)](/HoBo/crew/) · [HoBo CI](/HoBo/ci/) (where CI jobs run) · [Observability](/HoBo/observability/) · [CI/CD](/HoBo/cicd/)
