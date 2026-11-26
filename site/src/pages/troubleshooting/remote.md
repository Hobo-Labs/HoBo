---
layout: ../../layouts/Docs.astro
title: Remote debugging
description: "Inspect live Camps and Yards: projections, logs, incidents, runbooks, and policy-gated remediation."
---

# Remote debugging

## Read-only first

| Command | Use |
|---|---|
| `hobo inspect` | Time-travel projections (`run`, `deploy`, `topology`) |
| `hobo logs` | Streamer live-tail |
| `hobo identity status` | Continuous identity dual-path |
| `hobo trails status\|inspect` | Migration recipe state |
| `hobo drift` | Drift report (remediation still gated) |

## When you must change something

- Prefer canary / progressive paths ([CI/CD](/HoBo/cicd/)) 
- Production writes often `require-approval` 
- SRE/runbooks: [Operations](/HoBo/operations/) 

## Agent “what happened?”

[Agent audit & replay](/HoBo/observability/agent-audit/) — tool calls and token grants are facts.

## Related

[Common failures](/HoBo/troubleshooting/common-failures/) · [Observability](/HoBo/observability/) · [Bridge](/HoBo/troubleshooting/bridge/)
