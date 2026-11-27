---
type: Agent Skill Reference
title: "Git and PR flow"
description: "Preserve git history, keep PRs mergeable, and finish with clean status checks and comments resolved."
tags: [hobo, repo, git, pull-request]
timestamp: 2026-06-30T00:00:00Z
---

# Git And PR Flow

Use git as the source of truth for state, ownership, and history.

## Git Rules

- Use `git mv` for tracked moves and renames.
- Use `git status --short` before and after edits.
- Do not delete, reset, checkout, or overwrite user changes unless explicitly asked.
- Do not delete local branches or worktrees unless the task explicitly asks for cleanup.

## Final PR Loop

1. `git fetch origin`
2. `git merge origin/main` — never rebase a pushed branch, never force-push (`gh stack rebase` /
   `gh stack sync` only for unpushed local layers — see the `sdlc` skill)
3. Resolve conflicts without dropping either side's unrelated work.
   Before pushing, confirm `git fetch origin main && git merge-tree --write-tree origin/main HEAD`
   exits 0. GitHub runs no `pull_request` workflows on a head that conflicts with its base, or on a
   branch moved by the update-branch API, so that head never gets checks or reaches the queue.
   Update PR branches with a local `git merge` and push, never the update-branch API.
   When several agents share one machine, commit with `HOBO_TURBO_CONCURRENCY=1` and
   `HOBO_RELEVANT_CHECK_CONCURRENCY=1` so the pre-commit hook runs the same checks one at a time
   instead of failing on load-induced test timeouts.
4. Run `pnpm run agent:check -- --base=origin/main` for final PR-base validation.
5. Supersession check: if the head is already in `origin/main` or is an ancestor of another open
   PR's head (`git merge-base --is-ancestor <head> <other-head>`), do not open or keep a separate
   PR — close it with `Superseded by #N` (keep the branch).
6. Open or update **one** PR per workstream (multi-layer work: one PR for the top of the stack
   against `main`, not a PR per layer). Review and validate locally while it is a draft; mark it
   ready for GitHub Actions, and return it to draft to fix a failed gate on the same branch.
7. Request merge-commit auto-merge (`gh pr merge <n> --merge --auto`, or the merge queue with the
   merge-commit method) only when mergeability and required checks are clean. **Never squash,
   never rebase-merge.** Stacked work lands as one unit through the top PR — see the `sdlc`
   skill stack closeout.
8. Resolve requested changes and actionable comments — leave no open actionable threads.
9. Re-run the narrow relevant gate after repairs, then repeat PR-base validation only when the repair changes branch-level risk.
10. Clean the worktree and archive the thread only when supported by the active client tooling.

## Stacked PRs

Multi-step / multi-phase work uses GitHub's official stacked PRs (`gh extension install github/gh-stack`).
Parent agent owns stack topology; subagents do incremental commits on their layer. Full protocol:
`sdlc` skill and companion skill `gh-stack`.

Local agent defaults (also applied by `scripts/install-hooks.mts` / `setup-agent-tools.sh`):

```bash
git config --local rerere.enabled true
git config --local remote.pushDefault origin
```

## Merge Discipline

Review and validate changes locally while the PR is a draft. Mark it ready for review
to start GitHub Actions; do not run CI on drafts. If a gate fails, return the PR to
draft and repair the same branch before marking it ready again. Do not open another
PR to fix the failing gate.

Queue or merge only after the current ready-state required checks and applicable
release jobs actually pass. Pending, skipped, cancelled, unavailable, or failed
checks are not passes. Never bypass branch protections or required checks.

Address all review comments before merge. If another merge worker owns the final merge,
report the exact remaining state instead of pretending it shipped.
