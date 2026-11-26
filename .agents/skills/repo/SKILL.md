---
name: repo
description: Use when initializing, setting up, searching, changing, validating, committing, opening PRs, deploying, cleaning, or iterating in the HoBo repo. Routes agents through performance-first repo operations, local hybrid retrieval, narrow gates, git history preservation, PR handoff, and workspace cleanup.
---

# Repo

Use this skill for repo lifecycle work. Keep the hot path fast: search before validate, validate changed scope before package scope, validate package scope before repo scope, and use exact or structural tools before broad semantic retrieval.

## First moves

1. Run `git status --short` and preserve existing user or staged changes.
2. Read `AGENTS.md` and the relevant reference below before editing.
3. Use `git mv` for tracked file moves or renames.
4. Search narrowly before opening large files or running gates.
5. Run the narrowest relevant validation first, then explicit PR-base repo gates when the whole branch needs final confidence.

## Reference routing

- Init or setup: read `references/setup.md`.
- Search, retrieval, OKF, memories, `tgrep`, `rg`, `fd`, or `ast-grep`: read `references/search-retrieval.md`.
- Implementation iteration and scope control: read `references/implementation-loop.md`.
- Validation and required gates: read `references/gates.md`.
- Git, PRs, auto-merge, conflicts, comments, or commit hygiene: read `references/git-pr.md`.
- Cleanup, stale refs, worktrees, dependency hygiene, or generated artifacts: read `references/cleanup.md`.
- Deploy or release handoff: read `references/deploy.md`.

## Hard rules

- Do not bypass hooks, checks, merge protections, or status checks.
- Do not run install, update, prune, broad generation, or full repo validation as a diagnostic unless evidence shows it is required.
- Do not use Google products for OKF ingestion or querying by default. Treat OKF as markdown plus frontmatter in git.
- Prefer local hybrid retrieval first. Use cloud or BYOC retrieval only when explicitly requested or already configured.
- Finish whole-branch PR work by rebasing on `origin/main`, running `pnpm run agent:check -- --base=origin/main`, opening or updating the PR, resolving conflicts/checks/comments, cleaning the workspace safely, and archiving the thread only when the client provides a thread-archive tool.
- For iteration or a small post-rebase repair, use `pnpm run agent:check` for the latest commit or `pnpm run agent:check -- --staged` before committing. Do not pay for PR-base branch validation repeatedly.
