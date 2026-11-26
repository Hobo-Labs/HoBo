---
layout: ../../layouts/Docs.astro
title: Agent audit & replay
description: "Every agent observation, tool call, token grant, and approval is a fact — replay to answer what happened."
---

# Agent audit & replay

If an agent acted, the log can explain it. “The model said so” is not an audit trail.

## What is recorded

| Fact class | Examples |
|---|---|
| Dispatch | `crew.AgentDispatched` (operators) / session open |
| Tools | MCP invocations + results (redacted) |
| Tokens | Grants by **reference** |
| Policy | `policy.Decided`, obligations |
| Guardrails | `guardrail.Blocked` |
| Handoffs | A2H request/resolve |

## Replay questions

- What tools ran between T0 and T1? 
- Which policy version allowed the destroy proposal? 
- What was the fence/deployment correlation id? 

Use `hobo inspect`, event exports, and `hobo attest` for external GRC — not screenshots of secrets.

## Related

[Credentials](/HoBo/security/credentials/) · [Event families](/HoBo/reference/events/) · [Crew shared model](/HoBo/operations/shared-model/)
