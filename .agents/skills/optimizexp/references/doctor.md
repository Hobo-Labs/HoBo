---
type: Agent Skill Reference
title: "OptimizeXP doctor"
description: "Audit and safe repair of optimizexp structure, snapshots, feature quality, and persona formalization."
tags: [hobo, optimizexp, doctor, repair, snapshot, quality]
timestamp: 2026-07-31T00:00:00Z
---

# Doctor

`doctor` is the **workspace health** command for OptimizeXP. Run it before review loops and after large feature/persona edits.

Invoking OptimizeXP grants standing approval for doctor's safe, in-scope
repairs. Apply them without asking again. This never extends to destructive,
networked, secret-bearing, or unrelated changes.

## Invocation

```bash
node --import tsx .agents/skills/optimizexp/harness/doctor.mts check --project hobo
node --import tsx .agents/skills/optimizexp/harness/doctor.mts repair --project hobo
node --import tsx .agents/skills/optimizexp/harness/doctor.mts snapshot --project hobo
node --import tsx .agents/skills/optimizexp/harness/doctor.mts check --json
```

Aliases: `fix` → `repair`, `snap` → `snapshot`.

## Modes

| Mode | Behavior | Exit |
|---|---|---|
| **check** | Audit only | 1 if any **error** findings |
| **repair** | Safe automated fixes, then re-check | 1 if errors remain |
| **snapshot** | Copy metadata digests to `.optimizexp/snapshots/doctor-*` | 1 if check has errors (snapshot still written) |

## What it audits

### Structure
- Global + project `.optimizexp/` trees  
- `config.json` presence/validity  
- Managed `.gitignore`  
- `personas/`, `features/`, global `bus/entries/`, `runs/`  

### Personas
- Frontmatter `schemaVersion` (1|2)  
- Formal `experiences: [ux|dx|ax]` binding (required for selection)  
- v2 sections: Market segment, Demographic, Psychographic, Cognitive thresholds  
- `segmentIds` when schemaVersion 2  
- Thin bodies  

### Features (critical path quality)
- `feature.json` presence / id match  
- Template-only Gherkin ban (`When I exercise the surface…` alone)  
- `EXPERIENCE.md` rubber-duck + adversarial completeness  
- Monorepo keyword-trap `primaryCommand` (`eval:agent:*`, stray `agent:check`)  
- Stub implementation status  

### Surface map + catalog
- Missing/invalid `surface-map.json`  
- Interactive default without interactive surfaces  
- Missing `experience-catalog.json` / no cold-start P0 rows  

## Safe repairs (`repair`)

| Action | Effect |
|---|---|
| `ensure-scope` / `ensure-dirs` | Create `.optimizexp` dirs + `.gitkeep` |
| `ensure-config` | Write missing config.json templates |
| `ensure-gitignore` | Refresh managed ignore blocks |
| `persona-experiences-default` | Set `experiences: [dx, ax]` when empty/invalid |
| `persona-v2-sections` / `segmentIds` | Append stub KYC sections (agent should flesh out) |
| `feature-experience-skeleton` | Write `EXPERIENCE.md` draft (`Verdict: revise`) |
| `feature-json-id` | Align feature.json id to folder name |
| `build-surface-map` | `explore` with `--skip-probes` |
| `build-catalog` | Rebuild experience-catalog from map + personas |

**Not repaired automatically:** template-only Gherkin rewrite (requires agent judgment), product code, secrets, force-push.

Use `--only ensure-config,build-catalog` to limit actions.

## Snapshots

Safe **initial/workspace state** capture for recovery or PR attachments:

```text
.optimizexp/snapshots/doctor-<timestamp>/
  doctor-report.json
  manifest.json          # rel path + sha256 + bytes
  README.md
  tree/                  # config, personas, feature.json, EXPERIENCE.md, Gherkin, catalogs
```

Large evidence media (mp4/webm/gif/cast/png) is **not** copied.

## Relation to other harness commands

| Command | Role vs doctor |
|---|---|
| `init.mts` | Bootstrap empty product — doctor **maintains** existing trees |
| `explore-app.mts` | Full probe explore — doctor repair can rebuild maps offline |
| `generate-feature.mts validate` | Single-feature quality — doctor scans all features |
| `generate-persona.mts validate` | Single persona — doctor scans all personas |
| `review-loop assert-complete` | Run completion — doctor is **preflight**, not closeout |

## Agent protocol

1. After cloning or before `/optimizexp` review: `doctor check --project …`  
2. If errors/repairable: `doctor repair` then re-check  
3. Before risky multi-feature regen: `doctor snapshot`  
4. Do not treat doctor exit 0 as optimizexp complete  

## Output

Human summary by default; `--json` for full `DoctorReport` (findings, repairsApplied, snapshotPath).
