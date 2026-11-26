---
type: SkillOpt Evaluation Reference
title: "Draft skill SkillOpt evals"
description: "Local benchmark material for improving the repo-local draft skill with SkillOpt."
tags: [hobo, skillopt, draft-skill, evals]
timestamp: 2026-06-30T00:00:00Z
---

# Draft skill SkillOpt evals

This directory defines the local benchmark material for improving the repo-local `draft` skill with SkillOpt.

SkillOpt treats the markdown skill as trainable text state: target rollouts execute scored tasks, the optimizer proposes bounded edits, and only validation-improving candidates are adopted as `best_skill.md`. The repo keeps no-spend fixtures here so agents can run a mock dry run before opting into paid or credentialed backends.

## Loop

1. Seed from `.agents/skills/draft/SKILL.md`.
2. Review `tasks.md`, `rubric.md`, and `tasks.skillopt-sleep.json`.
3. Run the no-spend SkillOpt-Sleep proof:

   ```powershell
   $env:PYTHONPATH = (Resolve-Path .tmp/SkillOpt).Path
   py -3 -m skillopt_sleep.experiments.run_experiment --persona researcher --assert-improves
   ```

4. Run a safe dry-run replay of the draft fixtures:

   ```powershell
   $env:PYTHONPATH = (Resolve-Path .tmp/SkillOpt).Path
   py -3 -m skillopt_sleep dry-run --project .tmp/draft-skillopt-run --target-skill-path .agents/skills/draft/SKILL.md --tasks-file docs/skillopt/draft-skill/tasks.skillopt-sleep.json --backend mock --json
   ```

5. For real optimization, switch to a reviewed real backend such as Codex:

   ```powershell
   $env:PYTHONPATH = (Resolve-Path .tmp/SkillOpt).Path
   py -3 -m skillopt_sleep run --project .tmp/draft-skillopt-run --target-skill-path .agents/skills/draft/SKILL.md --tasks-file docs/skillopt/draft-skill/tasks.skillopt-sleep.json --backend codex --json
   ```

6. Run at least 10 real optimization iterations, or stop after 3 consecutive held-out validation non-improvements.
7. Adopt only the validation-winning staged proposal or `best_skill.md`.
8. Mirror the adopted skill into both `.agents/skills/draft/SKILL.md` and `.claude/skills/draft/SKILL.md`.

## Windows note

The repo wrapper `scripts/skillopt-sleep.sh` is Bash-based. On Windows sessions without Bash, use `py -3 -m skillopt_sleep ...` from a local SkillOpt source checkout or use `skillopt-train` directly after installing SkillOpt. As of the 2026-06-30 Windows run, the PyPI `skillopt` package exposes `skillopt-train` and `skillopt-eval`, while the preview `skillopt_sleep` package is available from the GitHub source tree rather than the wheel.

## Current local verification

- `skillopt-train` and `skillopt-eval` were installed with `py -3 -m pip install --user skillopt` and verified by absolute path under `%APPDATA%\Python\Python313\Scripts`.
- SkillOpt source was cloned to `.tmp/SkillOpt` to expose `skillopt_sleep`.
- The no-spend proof passed with `baseline held-out: 0.3333`, `after held-out: 1.0`, and `gate blocks harmful edit: True`.
- The draft fixture mock replay was run 3 times. Each replay scored `0.9917 -> 0.9917`, rejected the candidate, produced 0 edits, and staged/adopted nothing. This satisfies the no-spend stop condition of 3 consecutive held-out non-improvements for the reviewed draft fixtures.
- No live `draft` skill adoption should happen until a real backend run produces a validation-winning staged proposal.
