---
layout: ../../layouts/Docs.astro
title: Agent credentials
description: "Scoped short-lived agent credentials, capability declarations, brokered tokens, and no ambient admin."
---

# Agent credentials

Agents are first-class principals. They receive **scoped, short-lived** credentials — never ambient org-admin by default.

## Issuance loop

1. Agent authenticates (SVIDs / OIDC device flows as applicable). 
2. Declares needed capabilities for the task. 
3. Policy allow / deny / require-approval. 
4. Broker issues time-boxed token/scopes. 
5. Audit refs only in the log. 

## Rules

| Rule | Detail |
|---|---|
| Least privilege | Scope to tools + resources needed |
| Short TTL | Rotate; no long-lived agent PATs as default |
| No plaintext in context | Schema-only views and fixtures for secrets |
| Spend caps | Policy breakers on runaway tool use |
| MCP auth | Same policy plane as CLI |

## Related

[Agents overview](/HoBo/agents/) · [MCP](/HoBo/agents/mcp/) · [Identity](/HoBo/security/identity/) · [Audit](/HoBo/observability/agent-audit/)
