---
type: Agent Skill Reference
title: "OptimizeXP init"
description: "Repo traversal to seed UX/DX/AX personas and feature scenarios aligned with product surfaces."
tags: [hobo, optimizexp, init, discovery, personas, features]
timestamp: 2026-07-30T00:00:00Z
---

# Init

`/optimizexp --init` (or `harness/init.mts`) **bootstraps** OptimizeXP for a product repo:

1. **Traverse** the tree for product signals (README, site, UI tokens, packages, CLI, MCP, AGENTS.md, package scripts, draft exp-proofs, site roles).
2. **Create personas** for **UX**, **DX**, and **AX** that match what the product does.
3. **Create feature folders** (per-persona Gherkin, bindings, tests) for inferred critical journeys.
4. **Best-effort implement** step bindings when real scripts/commands exist.

Init alone does **not** run the full persona review loop. **Bare** `/optimizexp` (no flags) will auto-init when needed, then review with **all** experiences.

## Auto-init on bare run

When the user invokes optimizexp **with no flags**:

```bash
node --import tsx .agents/skills/optimizexp/harness/init.mts --mode needs-init
# exit 0 + needsInit:true  → run init (ux+dx+ax), then full review
# exit 1 + needsInit:false → skip init, full review with ux+dx+ax
```

### `needsInit` is true when

| Condition | Why |
|---|---|
| Zero personas under global **or** project `.optimizexp/personas/` | Nothing to judge with |
| Zero `feature.json` feature folders in any scope | No scenarios to exercise |
| No `product-*` / `role-*` personas **and** no global `init-report.json` **and** fewer than 2 features | Never product-bootstrapped |

Hand-authored personas alone with ≥2 features → **no** auto-init (review proceeds).  
Explicit `--init` always runs bootstrap. Explicit `--dx` / `--persona` / etc. do not auto-init unless both personas and features are empty.

## Invocation

```text
/optimizexp                    # auto needs-init → init if needed → review ALL experiences
/optimizexp --init
/optimizexp --init --experiences dx,ax
/optimizexp --init --force
/optimizexp --init --dry-run
```

```bash
node --import tsx .agents/skills/optimizexp/harness/init.mts --mode needs-init
node --import tsx .agents/skills/optimizexp/harness/init.mts
node --import tsx .agents/skills/optimizexp/harness/init.mts --dry-run
node --import tsx .agents/skills/optimizexp/harness/init.mts --experiences ux,dx --max-features 6
```

| Flag | Meaning |
|---|---|
| `--init` | Skill-level entry; agent runs `harness/init.mts` |
| `--mode needs-init` | Probe whether bare optimizexp should bootstrap first |
| `--mode list-projects` | List discovered multi-project ids (+ config paths) |
| `--mode ensure-config` | Write missing global/project `config.json` templates |
| `--mode validate-config` | Validate config JSON + merge |
| `--projects all\|a,b` / `--project <id>` / `--all-projects` | Scope init to project(s); **default all-projects** |
| `--dry-run` | Discovery + plans only |
| `--force` | Overwrite existing personas/features with same ids |
| `--experiences ux,dx,ax` | Limit which experience tracks to seed |
| `--skip-personas` / `--skip-features` | Partial init |
| `--skip-implement` | Scaffold Gherkin only (no discovery wire-up) |
| `--max-personas N` / `--max-features N` | Caps (default 12) |

## Discovery signals

| Signal | Typical personas / features |
|---|---|
| `site/`, UI tokens | UX end-user, designer; public site + design-system features |
| `packages/cli`, `hobo`, scripts | DX app developer, platform engineer; narrow validation, CLI doctor |
| `AGENTS.md`, `.mcp.json`, `packages/mcp` | AX agent operator, coding agent; agent tooling setup |
| `src/draft/exp-proofs` | Navigation feature for experience proofs |
| `site/.../roles/*` | Extra personas from documented product roles |

Product name/summary come from README `#` title + lead paragraph (fallback: root `package.json`).

## Outputs

```text
.optimizexp/                          # GLOBAL (always)
  config.json                         # formal monorepo defaults
  personas/…                          # cross-cutting / multi-project plans
  features/…
  init-report.json
  INIT.md
  bus/ runs/ backlog/                 # orchestration only here

site/.optimizexp/                     # PROJECT (when plan tags a single non-root project)
  config.json                         # formal project defaults (UX/web for site)
  personas/product-*.md
  features/<journey-id>/
```

Single-project plans (e.g. `--init --projects site`) write personas/features into **`site/.optimizexp/`**. Multi-project or root plans write to **global**. Init also ensures **config.json** templates (see `config.md`).

Default persona ids (when signals present):

| Id | Experiences |
|---|---|
| `product-end-user` | ux |
| `product-designer` | ux |
| `product-app-developer` | dx, ax |
| `product-platform-engineer` | dx, ax |
| `product-agent-operator` | ax, dx |
| `product-coding-agent` | ax, dx |

Existing hand-authored personas (e.g. `developer.md`) are **left alone** unless `--force` targets the same id.

## Agent duties after init

1. Read `INIT.md` + `init-report.json`.
2. **Rewrite** thin persona seeds into rich schema bodies (product vocabulary) where scaffold quality is low.
3. Refine Gherkin scenarios to real critical paths.
4. Run review: `/optimizexp --personas product-app-developer,product-end-user --features narrow-local-validation,...`
5. Do not invent product capabilities that discovery did not support — note gaps in INIT.md.

## Relation to other flags

| Flag | Role |
|---|---|
| **(none)** | Auto `needs-init` → maybe init → **review ux+dx+ax** + **all-projects** |
| `--init` | Bootstrap personas + features (stop unless also reviewing) |
| `--projects` / `--project` | Limit which product units are in scope (default **all**) |
| `--persona` | One-off seed rewrite |
| `--feature` | One-off journey scaffold |
| `--dx` / … | Review subset of experiences |

`--init --dx` only seeds DX-aligned plans.  
`--init --projects site` only seeds site-tagged personas/features.
