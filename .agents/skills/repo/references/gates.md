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

- Single-file / package tests: `pnpm --filter <pkg> exec vitest run <file>`, `pnpm --filter <pkg> test`, `node --import tsx --test scripts/test/<file>.test.ts`
- Changed / affected test lanes: `pnpm run test:changed`, `pnpm run test:affected`, `pnpm exec turbo run test --filter=./packages/<pkg>`
- Staged path: `pnpm run check:relevant:staged`
- Latest-commit path: `pnpm run agent:check`
- Branch path: `pnpm run check:relevant -- --base=origin/main`
- Final PR-base path: `pnpm run agent:check -- --base=origin/main`
- Technical standards: `pnpm run standards:check -- --base=origin/main`
- Visual tokens: always for visual/UI/TUI/dashboard changes, run impeccable critique/audit, `pnpm run design:lint`, and the affected package's design-lint and rendered-surface tests; do not wait to be asked
- OKF structure: `pnpm run docs:okf`
- Skill validation: no standalone validator ships in-repo; skill integrity is covered by `pnpm run skills:mirror-check` (byte-identical `.claude`/`.agents` mirrors) plus `pnpm run docs:okf` for reference bundles.

## Gate Rules

- Do not bypass hooks or use `--no-verify`.
- Always run only tests related to your changes. Never run full-repo sweeps (`pnpm test`, `pnpm run test:unit`, `pnpm run test:all`, `pnpm run check:all`, `pnpm run verify:full`, unfiltered `turbo run test`, or unfiltered root `vitest run`) unless the user explicitly asks for one (`HOBO_ALLOW_BROAD_TESTS=1`). The pre-tool hook (`scripts/agent-session-policy.mts`) refuses broad sweeps by default across Claude Code, Cursor, Codex, and Copilot.
- During a merge (`MERGE_HEAD`), `agent:check --staged` intersects staged diffs across merge parents so merging `origin/main` validates only conflict-resolved or merge-introduced files instead of unrelated upstream commits.
- If a command times out or starts broad work unexpectedly, stop and narrow scope before retrying.
- Use latest-commit or staged validation for small iteration and post-merge repair.
- Run explicit PR-base validation once the implementation is complete and conflicts are resolved.
