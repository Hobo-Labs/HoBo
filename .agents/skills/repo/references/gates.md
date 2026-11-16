---
type: Agent Skill Reference
title: "Repo gates"
description: "Select validation commands from fastest changed-scope checks to final repo gates."
tags: [hobo, repo, gates, validation]
timestamp: 2026-06-30T00:00:00Z
---

# Repo Gates

Failed validation is not a completion state. Fix the failure or report the blocker with evidence.

## Validation Order

1. Changed-file or staged checks.
2. Package or workspace checks.
3. Affected repo checks.
4. Final required gates.

## Common Commands

- Staged path: `pnpm run check:relevant:staged`
- Latest-commit path: `pnpm run agent:check`
- Branch path: `pnpm run check:relevant -- --base=origin/main`
- Final PR-base path: `pnpm run agent:check -- --base=origin/main`
- Technical standards: `pnpm run standards:check -- --base=origin/main`
- Visual tokens: `pnpm run design:lint` and affected rendered-surface tests for UI changes
- OKF structure: `pnpm run docs:okf`
- Skill validation: no standalone validator ships in-repo; skill integrity is covered by `pnpm run skills:mirror-check` (byte-identical `.claude`/`.agents` mirrors) plus `pnpm run docs:okf` for reference bundles.

## Gate Rules

- Do not bypass hooks or use `--no-verify`.
- Do not run full repo lint, test, typecheck, build, or codegen during implementation when an affected or changed-scope command exists.
- If a command times out or starts broad work unexpectedly, stop and narrow scope before retrying.
- Use latest-commit or staged validation for small iteration and post-rebase repair.
- Run explicit PR-base validation once the implementation is complete and conflicts are resolved.
