---
type: Agent Skill Reference
title: "OptimizeXP AX — agent skills"
description: "Skill authoring, progressive disclosure, dual-tree mirrors, and offline feature bindings."
tags: [hobo, optimizexp, ax, skills]
timestamp: 2026-07-31T00:00:00Z
---

# AX — agent skills

## Anatomy

```text
SKILL.md                 # frontmatter + thin steps
references/              # progressive disclosure (sectioned for AX under optimizexp/ax/)
workflows/               # optional host workflows
scripts/ / harness/      # deterministic helpers
```

## HoBo rules

- Mirror `.agents/skills/<name>` ↔ `.claude/skills/<name>` (byte-identical)  
- `pnpm run skills:mirror-check`  
- OKF frontmatter on reference concepts for `repo` / `draft` / `sdlc` / `optimizexp`  
- Codex-valid YAML frontmatter on `SKILL.md`  
- Progressive disclosure: load references by **branch/section**, not all at once  
- optimizexp discovery: **never** default primary-bind live egress scripts (`eval:agent:live`)  

## Repo-local skills (high traffic)

| Skill | AX role |
|---|---|
| `repo` | Lifecycle, search-before-test, PR hygiene |
| `draft` | Proof taxonomy + artifact gates |
| `sdlc` | Full loop; `/sdlc --finish` session land |
| `optimizexp` | UX/DX/AX measure→reduce→verify |
| `gh-stack` | Non-interactive stacked PRs |

## Friction smells

- Skill body longer than needed; empty or missing `references/`  
- Duplicate skills with different names across hosts  
- Model-invoked description bloat (loaded every turn)  
- Feature bindings to live evals for offline seeds  
- Stale steps/README still advertising old primary commands  

## Uncertainty smells

- Skill tells agent to run full monorepo tests as first step  
- Conflicting instructions vs `AGENTS.md`  
- Missing completion criteria → premature completion  
- “Plateau” claimed while implementable S/M findings remain (optimizexp)  

## Optimization moves

1. Thin SKILL.md; sectioned references (this AX tree is the template).  
2. Mirror-check in agent:check when skills change.  
3. code-discovery demotes live scripts; exp-proofs use classification path.  
4. Keep feature `steps/README.md` primary binding in sync with `feature.json`.  
5. Authoring: leading words, ladder, no-ops (writing-great-skills vocabulary).  

## Evidence

- `pnpm run skills:mirror-check`  
- Feature binding tests under `.optimizexp/features/*/test/`  
- Diffs that remove live primaryCommands from offline features  

## Related

- [index.md](index.md) — AX section load map  
- [token-optimization.md](token-optimization.md) — skill size  
- [harness-clis.md](harness-clis.md) — how skills invoke gates  
