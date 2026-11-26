---
type: Agent Skill Reference
title: "OptimizeXP DX — repo and package hierarchy"
description: "Repository layout, package boundaries, and navigation ergonomics for humans and agents."
tags: [hobo, optimizexp, dx, monorepo, packages]
timestamp: 2026-07-30T00:00:00Z
---

# DX — repo & package hierarchy

## Healthy shape

```text
packages/<name>/{src,test,contracts,data-models}
apps|site/
src/draft/<kind>/…          # proofs, not production growth
docs/design/                # design suite
scripts/                    # repo automation
.agents/skills + .claude/skills  # mirrored agent skills
```

## HoBo rules that reduce friction

- Parallel work: edit one package/feature folder
- Avoid shared global files unless task requires
- Production packages scaffolded (konsistent)
- Draft taxonomy with gate-enforced artifacts
- Promotion freezes draft after lift-and-leave

## Uncertainty smells

- Two homes for the same concept (docs vs packages diverged)
- Barrel files that force global churn
- Unclear which tree is canonical after promotion

## Navigation aids

- OKF `index.md` maps
- `AGENTS.md` package map for EventStore / stations / etc.
- `docs/design/index.md` design suite entry
