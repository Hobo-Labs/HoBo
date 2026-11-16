---
type: Agent Skill Reference
title: "OptimizeXP PR delivery"
description: "Incremental commits, stacked PRs per iteration, and posting evidence to pull requests."
tags: [hobo, optimizexp, pr, stacked-prs, evidence, gh]
timestamp: 2026-07-30T00:00:00Z
---

# PR delivery

When an optimizexp iteration produces findings, evidence, and (optionally) reductions, land work as a PR with **incremental check-ins** and post **evidence** on the PR.

## Incremental check-ins (within one iteration)

During a single iteration, commit often — do not wait for plateau:

| Checkpoint | Commit when |
|---|---|
| Feature scaffold | `features/<id>/` + Gherkin added |
| Bus expect/outcome batch | meaningful bus entries (no secrets) |
| Evidence capture | `evidence/<scenario>/` primary overwritten |
| Score/findings | `runs/<id>/iterations/NNN/` |
| Reduction applied | code/docs fix for top finding |

Use conventional commits, e.g. `test(optimizexp): capture staged-check evidence`.

## Stacked PRs (prefer when available)

**One PR stack entry per review iteration** when stacking is configured.

Detect:

```bash
gh extension list 2>/dev/null | rg -i 'stack|gh-stack|graphite' || true
gh stack --help 2>/dev/null || true
```

| Tooling | Behavior |
|---|---|
| GitHub `gh` stack extension (`gh stack`) | Prefer `gh stack` submit/restack flows; one stack PR per iteration |
| Graphite (`gt`) | Acceptable alternate if already the repo’s stack tool |
| Neither installed | Single PR on a branch `optimizexp/<runId>`; still incremental commits |

Iteration branch naming:

```text
optimizexp/<runId>/iter-NNN
# stacked base: optimizexp/<runId>/iter-000 → iter-001 → …
```

Do **not** force-install stack extensions without user permission. If missing, note in `summary.md` and continue with a linear PR.

## Posting evidence to the PR

After `gh pr view` shows a PR for the branch:

```bash
node --import tsx .agents/skills/optimizexp/harness/post-pr-evidence.mts \
  --feature <feature-id> \
  --pr <number|url> \
  # or auto-detect PR for current branch
```

### Payload strategy

1. Prefer attaching/linking **committed** evidence paths (always works for reviewers who check out the branch).
2. Additionally post a PR comment with:
   - scenario table
   - inline images if small enough
   - video links or details attachments
3. If API rejects size:
   - compress / downscale (`ffmpeg`, `pngquant` if present)
   - convert video → short GIF
   - split into multiple comments (one scenario per comment)
   - fall back to comment with repo-relative paths only

### Size heuristics

| Kind | Try upload | Else |
|---|---|---|
| Image ≤ ~1 MiB | PR comment image / gist | path link |
| GIF ≤ ~2 MiB | PR comment | path link |
| Video ≤ ~5 MiB | PR attachment if supported | compress or path link |
| Larger | never raw upload | path + optional external artifact store only if user configured |

Never commit secrets in evidence. Never paste binary base64 walls into PR bodies when a path link suffices.

## Ordering

1. Incremental commits on iteration branch  
2. Open or update PR (stacked if available)  
3. Capture/overwrite evidence (committed)  
4. Push  
5. `post-pr-evidence` comment  
6. Continue loop or open next stack PR for next iteration  

## Permissions

- Opening/commenting on PRs is a **user-visible** action: confirm once per run if the user did not already ask to open a PR.
- If the user said “run optimizexp and open PRs”, treat that as blanket approval for this run’s stack.
