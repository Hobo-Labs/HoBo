# OptimizeXP baseline evaluation (repo scaffold)

**Run:** `20260730-baseline-eval`  
**Mode:** recon + skill bootstrap (not a full multi-iteration reduction)  
**Experiences:** ux, dx, ax  

This run documents the **starting experience posture** of the HoBo repo when the optimizexp skill was introduced. Use it as the first baseline for later scored loops.

## Strengths (low friction / uncertainty)

| Area | Evidence |
|---|---|
| DX impact-scoped gates | `pnpm agent:check`, `scripts/relevant-check-policy.ts`, performance-first ladder in `AGENTS.md` |
| DX draft gates | `draft:artifacts`, `draft:cascade`, proof taxonomy |
| UX design contract | `site/DESIGN.md` + `design-md` skill + `design:lint` |
| AX multi-agent wiring | Mirrored skills, shared MCP launchers, progressive setup script |
| AX methodology | `sdlc`, `repo`, `draft`, superpowers, improve |

## Seed findings (candidates for a real review loop)

| ID | Exp | Metrics | Finding | Smallest reduction |
|---|---|---|---|---|
| F-1 | AX | uncertainty, friction | Repo-local skill set grew (`repo`/`draft`/`sdlc`) but `docs:okf` / docs lists lagged until optimizexp wired them | Keep OKF bundle list and AGENTS skill inventory in the same PR as new skills |
| F-2 | AX | uncertainty | No root `AUTH.md` — keys split across AGENTS + agent-tooling + `.env.example` | Added `AUTH.md` as single standing auth surface |
| F-3 | AX | friction | Skill dual-tree requires manual mirror; easy to edit one side | `skills:mirror-check` already exists — optimizexp mirrored at create time; document `cp -a` in skill authoring |
| F-4 | DX | friction | Broad validation still tempting; many scripts | Keep advertising staged/latest-commit modes in every new skill (optimizexp does) |
| F-5 | UX | uncertainty | DESIGN.md strong for site; product app UI (if any) not yet a second DESIGN.md | When product UI lands, add DESIGN.md beside it or extend site contract deliberately |
| F-6 | AX | harms risk | gbrain egress is documented but easy to miss mid-session | AUTH.md + setup `--no-gbrain` default path |
| F-7 | DX | friction | `tgrep` may be missing; search falls back to `rg` | Document fallback in doctor / agent-tooling (already partially noted) |
| F-8 | AX | friction | Hosts without workflows had no shared review orchestration | Cross-agent `review-loop.mts` + per-host workflow folders |

## Suggested first scored loop

```text
/optimizexp --ax --only ax
# personas: agent-operator, coding-agent
# surfaces: skills mirror, MCP configs, AUTH.md, setup script
```

Then:

```text
/optimizexp --dx
# surfaces: agent:check staged path, hooks, package scripts
```

## Plateau

Not run — this document is a **bootstrap baseline**, not a closed metric loop. Next optimizexp invocation should write bus expect/outcome pairs and numeric cells under `iterations/`.
