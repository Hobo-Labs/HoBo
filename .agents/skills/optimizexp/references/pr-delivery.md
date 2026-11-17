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
  --pr <number>
# Omit --pr to auto-detect the current branch's PR.
```

Posting accepts consistent evidence while playback review is pending. The
manifest and metadata must identify the same primary and match its current
digest; an accepted review must also match that artifact. The index reports
the review status. File paths and transcript text are formatted as literal
evidence, including when they contain Markdown delimiters; malformed kind names
are rejected before posting. If a feature ID exists in multiple scopes, pass
`--project <id>` (or `--project root`) to select one; posting refuses an
ambiguous or missing selection. A failed scenario comment makes the command
fail after it reports every attempted comment.

### Payload strategy

The command posts a scenario index and one comment per scenario. It references
small images and GIFs and includes excerpts from small transcripts; videos and
larger files use their repository paths. The command does not upload or
compress files, so commit and push the evidence before posting. Image references
are limited to 1,000,000 bytes and GIF references to 2,000,000 bytes. Transcript
excerpts are clipped to 12,000 characters.

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
