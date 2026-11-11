# OptimizeXP (repo config)

Repo-local configuration for the **optimizexp** agent skill.

## Global vs project scopes

| Location | Role |
|---|---|
| **`.optimizexp/`** (this directory, repo root) | **Global** — `config.json`, cross-cutting personas/features, **and** all bus/runs/backlog orchestration |
| **`<project>/.optimizexp/`** (e.g. `site/.optimizexp/`) | **Project-local** — `config.json`, personas/features/evidence for that product only |

Reviews **merge** global + selected project trees. Same persona/feature id: **project-local shadows global**. Write with a single non-root `--project <id>` lands under that project's tree; multi/all/root → global.

**Config** (`config.json`, schemaVersion 1): formal defaults (experiences, passes, delight, survey), persona/feature prefer+exclude, evidence policy, safety (offline-first), project surfaces, **gitignore policy**. Optional — skill works without it. Merge: builtins → global → project → **CLI wins**. See skill `references/config.md`.

**`.gitignore`:** managed block (runs/, bus entries, large evidence media). Customize via `config.json` → `gitignore.extra` / `gitignore.negate` / category toggles; user rules outside the managed markers are preserved. Refresh: `init.mts --mode ensure-config`.

| Path (global) | Role |
|---|---|
| `config.json` | Formal monorepo OptimizeXP config |
| `.gitignore` | Managed ignores for ephemeral/large artifacts |
| `personas/*.md` | Cross-cutting persona prompts (`experiences: [ux\|dx\|ax,…]`) |
| `features/<slug>/` | Cross-cutting feature folders (Gherkin, `feature.json`, `evidence/`) |
| `features/<slug>/<slug>-<persona>.feature` | One Gherkin file per targeted persona |
| `features/<slug>/evidence/<scenario>/` | **One** primary recording per scenario (overwritten on re-run) |
| `bus/entries/` | Append-only bus: **expect / act / outcome** (+ optional `survey`) |
| `bus-archive/entries/` | Legacy pre-scorecard-contract bus entries (282, moved out of the live bus; **not** scanned by `validate-bus`; see `bus-archive/README.md`) |
| `runs/<run-id>/` | Per-run scope, scores, iterations, summary |
| `runs/<run-id>/survey/` | End-of-run persona survey responses |
| `runs/<run-id>/backlog.json` | Ranked uplift experiments for this run |
| `backlog/experiments.json` | Global merge of survey-driven experiment backlog |
| `cucumber.yaml` | Cucumber profile for experience features |
| `features/cli-product/` | Product-CLI coverage features driven from the real `hobo` surface |

Skill (progressive disclosure + harness + host workflows):

- `.agents/skills/optimizexp/` (Cursor / Codex / shared)
- `.claude/skills/optimizexp/` (Claude Code mirror — byte-identical)

**AX (`--ax`) sectioned refs** (load `references/ax/index.md` first): specs · MCP · agent-skills ·
harness-clis · model-routing · token-optimization · agents-md · agents-config · hooks-plugins · auth.

## Quick start

```text
/optimizexp                        # needs-init? → init if needed → review+reduce ALL ux+dx+ax
/optimizexp --init                 # bootstrap only
/optimizexp --init --dry-run
/optimizexp --dx                   # passes=infinite → until metrics=0 or irreducible
/optimizexp --ax --passes 3        # optional cap: at most 3 completion cycles
/optimizexp --dx --report-only     # measure only, no code experiments
/optimizexp --personas product-app-developer --features narrow-local-validation
```

**Default behavior:** each review iteration **applies a reduce experiment** (smallest safe fix for the top finding), then re-captures evidence and re-scores. Opt out with `--report-only` / `--no-reduce`.

**`--passes` (default `infinite`):** dual regime until **Pareto equilibrium** — harm floor **switches** to delight maximize under harm non-regression + **cognitive thresholds**. Optional finite `--passes N` caps harm cycles only. `--no-delight` / `--harm-only` opts into early exit at the harm floor.

**Delight regime:** excitement / ease / optimality (higher better). Reject experiments that raise harm or breach persona cognitive budgets (sprawl, clutter, choice overload, …).

**Personas (schema v2):** synthetic demographic + psychographic models + cognitive thresholds for segment-aware scoring.

**Survey + backlog:** default on → `runs/<id>/survey/`, `backlog.json`, `.optimizexp/backlog/experiments.json`.

**Anti-stall:** if the agent can name a concrete fix, it must implement it and continue — not stop on “needs install,” “env,” or flat scores with an open S/M backlog. True plateau = flat scores **and** zero implementable findings. **There is no review-iteration budget.**

### Seeds vs selection

| Flag | Meaning |
|---|---|
| **(none)** | Auto-detect init need; then review **all** experiences + **all projects** |
| **`--init`** | Traverse repo → UX/DX/AX personas + feature/scenarios from product signals |
| **`--projects all`** / **`--project site`** | Multi-project scope (default **all-projects**) |
| `--persona "…"` | Seed → rewrite → formal `personas/<id>.md` (never raw as system prompt) |
| `--personas a,b` | Select existing persona ids (**exclusive** when set) for the run **and** feature fan-out |
| `--feature "…"` | Journey seed → `features/<id>/` with **one `.feature` per resolved persona** |
| (no persona flags) | Feature generation targets **all** personas intersecting experiences |

```bash
# does bare optimizexp need init?
node --import tsx .agents/skills/optimizexp/harness/init.mts --mode needs-init

# list multi-project ids
node --import tsx .agents/skills/optimizexp/harness/init.mts --mode list-projects

# bootstrap from product repo (all projects, or scoped)
node --import tsx .agents/skills/optimizexp/harness/init.mts
node --import tsx .agents/skills/optimizexp/harness/init.mts --projects site,cli
node --import tsx .agents/skills/optimizexp/harness/init.mts --dry-run

# generate a persona from a seed
node --import tsx .agents/skills/optimizexp/harness/generate-persona.mts \
  --seed "SRE who lives in Grafana and hates log archaeology" --id grafana-sre

# generate a feature (Gherkin per persona + bindings/tests)
node --import tsx .agents/skills/optimizexp/harness/generate-feature.mts \
  --seed "Staged agent check is narrow and actionable" --id agent-check-staged \
  --experiences dx --personas developer,coding-agent

# re-wire implementations from code discovery
node --import tsx .agents/skills/optimizexp/harness/generate-feature.mts \
  --mode implement --id agent-check-staged

# smoke bindings
pnpm run test:file .optimizexp/features/agent-check-staged/test/agent-check-staged.bindings.test.ts

# who would be targeted?
node --import tsx .agents/skills/optimizexp/harness/generate-feature.mts \
  --mode resolve-personas --experiences dx

# capture / overwrite evidence for a scenario
node --import tsx .agents/skills/optimizexp/harness/capture-evidence.mts \
  --mode capture --feature agent-check-staged --scenario "…" --driver cli --command 'pnpm -v'

# after a PR exists: post evidence comments (size-aware)
node --import tsx .agents/skills/optimizexp/harness/post-pr-evidence.mts --feature agent-check-staged
```

## Metric scorecards (expect / act / outcome)

Every bus phase emits formal **`scores`** against **harms**, **friction**, and **uncertainty** (0–5):

| Phase | Role | Meaning |
|---|---|---|
| expect | `predicted` | Forecast if the expectation holds |
| act | `observed` | First-pass scores from evidence/capture |
| outcome | `judged` | Final persona scores + `comparison` deltas |

Iteration rollups use **judged** outcomes only. Scorecards may carry **`evidenceChecks`** (named evidence assertions backing the scores) and a **`justification`** (required when a copied-forward score is not re-measured). See skill `references/metric-scorecard.md`.

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts --mode validate-bus
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts --mode aggregate-bus --run <runId>
```

## Known defects (KNOWN-DEFECTS.md)

A feature folder may carry a `KNOWN-DEFECTS.md` (see `features/cli-product/KNOWN-DEFECTS.md`) characterizing scenarios tagged `@known-defect`: they assert the **current, defective** product behavior so the suite stays green, and the owning fix flips the assertions and removes the tag.

## Drift protection

`pnpm run optimizexp:check` ([`scripts/check-optimizexp.mts`](../scripts/check-optimizexp.mts)) hard-fails on (a) persona schema-v2 validation across the global and project-local persona trees, (b) the skill's feature-quality lint (template-only Gherkin ban, `@persona:`/`@interface:` tags) over every feature folder, and (c) `validate-bus` over the live bus (`.optimizexp/bus/entries/`). The 282 legacy entries that predated the scorecard-evidence contract were archived to [`bus-archive/`](bus-archive/README.md), which the validator does not scan, so the bus lane is now a hard gate. The lane auto-selects in `agent:check` when `.optimizexp/**`, the skill mirrors, or the gate script change.

Current-head design-council validation hashes full binary Git diffs and supports
reviewed source evidence payloads up to 16 MiB.

## Evidence policy

1. Prefer **video** for visual surfaces (web / native / rich TUI).
2. Else keyframe screenshots → stitch to video/GIF (`--mode stitch`).
3. CLI: transcript + terminal size (cols×rows).
4. **One** `primary.*` per scenario; new runs **overwrite**.
5. Bus outcomes link to evidence paths; they do not embed binaries.

## PR delivery

- Incremental commits throughout each iteration.
- Prefer **stacked PRs per iteration** when `gh stack` (or Graphite) is available.
- Post evidence to the PR; compress/split when oversized.

See skill references: `flags.md`, `personas.md`, `features.md`, `evidence.md`, `harness.md`, `pr-delivery.md`.

## Adding a persona

Prefer `/optimizexp --persona "seed"` or `generate-persona.mts`. Keep `schemaVersion: 1` and required sections (skill `references/personas.md`).

## Git

Commit **personas**, **features** (including current evidence), and skill files.  
`bus/entries/` and ephemeral `runs/` may be committed as fixtures or left local.  
`bus-archive/` is local-only legacy history (gitignored) and must not be re-committed.
