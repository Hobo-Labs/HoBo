---
type: Agent Skill Reference
title: "OptimizeXP evidence harness"
description: "Auto-implemented test harnesses that drive Gherkin scenarios and capture persona-visible evidence."
tags: [hobo, optimizexp, harness, playwright, tui, cucumber]
timestamp: 2026-07-30T00:00:00Z
---

# Evidence harness

Skill-local harness under:

```text
.agents/skills/optimizexp/harness/
  init.mts                 # --init repo traverse → personas + features
  capture-evidence.mts     # evidence capture
  generate-persona.mts     # --persona seed → formal persona.md
  generate-feature.mts     # --feature seed → per-persona Gherkin folder
  scorecard.mts            # formal metric scorecards
  survey.mts               # persona survey + experiment backlog
  lib/
    paths.mts
    slug.mts
    redaction.mts
    media.mts
    scorecard.mts          # primary + positive metrics
    persona-resolve.mts    # shared persona selection
    repo-discover.mts      # product signals for init
    code-discovery.mts
    bindings-gen.mts
  drivers/
    cli.mts
    tui.mts
    web.mts
    native.mts
  post-pr-evidence.mts
```

Invoke (repo root):

```bash
node --import tsx .agents/skills/optimizexp/harness/capture-evidence.mts --help
# or: node --experimental-strip-types …
```

## Modes

| Mode | Purpose |
|---|---|
| `init-feature` | Scaffold `.optimizexp/features/<id>/` + `feature.json` + stub `.feature` |
| `list-scenarios` | Parse feature files → scenario slugs |
| `capture` | Run a driver against a scenario and write/overwrite evidence |
| `stitch` | Build video/GIF from `frames/` |
| `validate` | Ensure each **captured** scenario has exactly one primary; `--strict` requires evidence for every scenario |

### init.mts

| Flag / mode | Purpose |
|---|---|
| (default) | Discover product → create personas + features + implement bindings |
| `--mode needs-init` | Exit 0 if bare optimizexp should init first; exit 1 if ready to review |
| `--mode list-projects` | List multi-project ids for `--projects` |
| `--projects all\|a,b` | Scope init (default all-projects) |
| `--dry-run` | Print plans only |
| `--force` | Overwrite existing ids |
| `--experiences ux,dx,ax` | Limit tracks |
| `--skip-personas` / `--skip-features` / `--skip-implement` | Partial |

Corresponds to **`--init`** and bare-run auto-init. Details: `references/init.md`.

### generate-persona.mts

| Mode | Purpose |
|---|---|
| `scaffold` | Write formal `.optimizexp/personas/<id>.md` from `--seed` / `--seed-file` |
| `validate` | Check persona schema (frontmatter + required sections) |
| `rewrite-prompt` | Print agent instructions to flesh out a seed |

Corresponds to skill flag `--persona "seed text"` (see `references/flags.md`, `references/personas.md`).

### generate-feature.mts

| Mode | Purpose |
|---|---|
| `scaffold` | Feature folder + per-persona Gherkin + **bindings + tests + discovery** |
| `implement` | Re-run code discovery; rewrite `implementations.ts` / bindings / vitest |
| `validate` | Gherkin + `steps/*` + `test/*.bindings.test.ts` |
| `resolve-personas` | Dry-run persona targeting (no write) |
| `rewrite-prompt` | Agent instructions for quality Gherkin + impls |

Persona targeting args: `--personas`, `--generated-ids`, `--experiences`, `--max-personas` (same rules as skill flags). Corresponds to `--feature "seed text"`.

**Code discovery** (`lib/code-discovery.mts`): scans `package.json` scripts, backtick commands in seed/Gherkin, known paths. High/medium hits wire `exerciseSurface`; otherwise stubs.

**Cucumber profile:** `.optimizexp/cucumber.yaml` (separate from product `test:behavior`).

## Driver selection

From `feature.json` `driver` or CLI `--driver`:

| Driver | Behavior |
|---|---|
| `cli` | Spawn command; capture stdout/stderr/exit; write replayable `primary.cast` + supporting `terminal.txt` and meta with terminal size |
| `tui` | Like cli plus richer terminal recording: prefer `asciinema` if installed; always store cols/rows for repro |
| `web` | Prefer Playwright (`playwright` / `@playwright/test` if present); else browser MCP tools if the host exposes them; capture video if context allows, else screenshots |
| `native` | Computer-use style: invoke configured screenshot/recorder command (`OPTIMIZEXP_NATIVE_CAPTURE` or `--native-cmd`); prefer video |

Drivers are **best-effort adapters**. Missing optional binaries degrade along the evidence fallback chain (`references/evidence.md`) and record `degraded: true` in meta.

## Step hooks

Optional `steps/*.mts` under a feature may export:

```ts
export async function beforeScenario(ctx) { /* … */ }
export async function afterScenario(ctx) { /* … */ }
```

The harness loads them if present; otherwise it runs the `--command` / `--url` supplied on the CLI.

## Scenario slug

```text
"Staged skill edit selects skill gates" → staged-skill-edit-selects-skill-gates
```

Harness normalization: lowercase, non-alnum → `-`, collapse dashes, trim.

## Overwrite semantics

`capture` always:

1. Ensures `evidence/<scenario-slug>/` exists
2. Removes previous `primary.*` (and optional old frames when replacing still sets)
3. Writes new primary + `meta.json` + `manifest.json` with `overridesPrevious: true` when a prior primary existed

## Integration with review loop

1. Bus **expect** cites `featureId` + `scenarioSlug` + planned driver + formal **`scores` (predicted)**
2. Harness **capture** runs
3. Bus **act** links evidence path + formal **`scores` (observed)**
4. Bus **outcome** links evidence + feelings + formal **`scores` (judged)** + **`comparison`**
5. Iteration cells come from judged outcomes (`aggregate-bus`)

Scorecard CLI: `harness/scorecard.mts` (`validate` | `build` | `compare`).

### survey.mts

| Mode | Purpose |
|---|---|
| `template` | Scaffold `runs/<id>/survey/<persona>.json` + `_instrument.json` |
| `validate` | Check one survey response against schema |
| `aggregate` | Roll up positive metrics + featureRequests → `survey/aggregate.json` |
| `rank-backlog` | Rank experiments → `runs/<id>/backlog.json`; `--global` merges `.optimizexp/backlog/experiments.json` |

```bash
node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode template --run <runId>
node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode aggregate --run <runId>
node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode rank-backlog --run <runId> --global
```

See `persona-survey.md`, `experiment-backlog.md`, `positive-metrics.md`.

## Not a replacement for product cucumber

Repo epic proofs still use `pnpm run test:behavior`. OptimizeXP features are **experience-review** specs: they may call product gates, but their purpose is persona judgment + evidence, not production acceptance alone.
