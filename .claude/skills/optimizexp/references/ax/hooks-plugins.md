---
type: Agent Skill Reference
title: "OptimizeXP AX — hooks and plugins"
description: "Session hooks, plugins, and always-on rules that shape agent behavior."
tags: [hobo, optimizexp, ax, hooks, plugins]
timestamp: 2026-07-31T00:00:00Z
---

# AX — hooks & plugins

## Types

| Kind | Examples |
|---|---|
| SessionStart hooks | Superpowers skill load |
| Tool/shell hooks | RTK compress, git guardrails |
| Always-on rules | caveman `.cursor/rules`, AGENTS block |
| Plugins / marketplaces | Superpowers, optional ponytail plugin |

## Score for

- **Predictability**: does SessionStart load what docs claim?  
- **Disable path**: can a user turn off always-on compression?  
- **Composition**: two always-on systems fighting (tone + verbosity)  
- **Safety**: hooks that block `git push --force` without blocking normal work  

## HoBo anchors

- `.claude/settings.json` marketplaces + plugins  
- RTK `rtk init -g` per agent (setup script agent layer)  
- Caveman default on; disable instructions in AGENTS.md  
- `git-guardrails-claude-code` skill scripts  

## Uncertainty smells

- Plugin skills only load after “fresh session” but docs omit that  
- Hooks fail silently  
- Telemetry defaults on without note (`SUPERPOWERS_DISABLE_TELEMETRY=1`)  

## Optimization moves

1. Document session-start requirements next to plugin install.  
2. Token tools: [token-optimization.md](token-optimization.md).  
3. Setup script initializes hooks only in selected agent layer.  
4. Prefer fail-open for optional quality hooks; fail-closed for secret/destructive guards.  

## Related

- [agents-config.md](agents-config.md)  
- [token-optimization.md](token-optimization.md)  
