---
type: Agent Skill Reference
title: "Repo cleanup"
description: "Separate safe git maintenance from explicit cleanup tools and avoid destructive repo-store commands."
tags: [hobo, repo, cleanup, maintenance]
timestamp: 2026-06-30T00:00:00Z
---

# Repo Cleanup

Cleanup tools are not normal implementation tools. Identify cleanup opportunities during implementation, but run cleanup only when the task asks for it or final validation requires it.

## Safe Maintenance

- `git fetch --prune` for stale remote-tracking refs.
- `git worktree prune` only for stale worktree metadata.
- `git maintenance run --auto` for safe Git maintenance.

## Avoid Unless Explicitly Requested

- `git prune`
- `git gc --prune=now`
- `git reflog expire`
- deleting `node_modules`
- `pnpm store prune`
- dependency normalization or broad generated-artifact cleanup

## Cleanup Order

1. Fix stale generated or broken files.
2. Remove unused files.
3. Remove unused exports.
4. Remove unused dependencies.
5. Normalize dependency versions.
6. Re-run typecheck.
7. Re-run changed tests.
8. Run final validation.
