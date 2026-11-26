---
layout: ../../layouts/Docs.astro
title: Engines & ports
description: "Each Crew brain is an engine behind a port — swap SRE for HolmesGPT-class engines without rewriting the Yard."
---

# Engines & ports

Every Crew member is **pluggable**: the Yard depends on a **port**; a default engine ships; operators may swap engines that pass the same contract.

## Why ports

| Benefit | Detail |
|---|---|
| Swap brains | Better model / specialist engine without rewriting dispatch |
| Testability | Fake engines in CI |
| Policy | Engine choice is still RBAC-scoped |
| Audit | Tool calls and outputs remain events regardless of engine |

## Patterns

- Default built-in engine per operator
- Optional external engines (e.g. HolmesGPT-class for SRE)
- MCP tool surface stays stable — engines are implementation
- Never give an engine ambient admin outside its role

## Related

[Shared model](/HoBo/operations/shared-model/) · [SRE](/HoBo/operations/sre/) · [MCP](/HoBo/agents/mcp/)
