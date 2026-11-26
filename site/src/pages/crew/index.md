---
layout: ../../layouts/Docs.astro
title: The Crew — custom ACP agents
description: "Bring your own agents over ACP/A2A connectors: policy-gated, audited, MCP-reachable — without replacing built-in Operations operators."
---

# The Crew — custom ACP agents

**The Crew** (this section) is for **custom agents you bring** — ACP/A2A-connected, policy-gated, audited. Built-in Yard operators (SRE, GitOps, FinOps, …) live under **[Operations](/HoBo/operations/)**.

## Disambiguation

| Term | Where |
|---|---|
| **Custom ACP / A2A agents** | This section |
| **Built-in operator agents** | [Operations](/HoBo/operations/) |
| **Agents-as-users** (developer copilots) | [HoBo for Agents](/HoBo/agents/) |
| **`agent()` runtime primitive** | SDK — both kinds use it |
| **Relay** | Network proxy — *not* an agent |

## What you configure here

| Topic | Page |
|---|---|
| Agent-as-user identity & MCP | [HoBo for Agents](/HoBo/agents/) · [MCP surface](/HoBo/agents/mcp/) |
| Credentials (scoped, short-lived) | [Agent credentials](/HoBo/security/credentials/) |
| Pluggable engines / ports | [Engines](/HoBo/operations/engines/) (shared machinery) |
| Connector protocol (`a2a` / `acp`) | [Connectors](/HoBo/customizations/connectors/) · Bindle `connector(..., { protocol: "acp" })` |

## Rules for custom agents

1. Authenticate as first-class principals — never ambient org-admin 
2. Every tool call and token grant is an auditable fact 
3. High-risk writes pass Gatekeeper / policy obligations 
4. Prefer connector protocols HoBo owns (ACP/A2A) over inventing a private agent SDK 

## Related

[Operations](/HoBo/operations/) · [Security](/HoBo/security/) · [Observability / audit](/HoBo/observability/agent-audit/)
