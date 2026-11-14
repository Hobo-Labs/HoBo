---
type: Agent Skill Reference
title: "SDLC dispatch protocol"
description: "Permission-gated, harness-agnostic dispatch across cloud coding agents and local subagents, with one handback schema, an independent Done rule, and resume/reconcile."
tags: [hobo, sdlc, dispatch, subagents, coding-agents]
timestamp: 2026-07-02T00:00:00Z
---

# Dispatch

## Permission gate

Ask the user before offloading ANY work to implementation agents, once per initiative (or
per batch if the user prefers). No permission → the loop stops at the Linear capture phase.

## Backend matrix (pick per issue, not per initiative)

The coordinator does not hardcode one delegation mechanism. Detect what the current harness
offers, then choose per issue:

| Backend | How to dispatch | Isolation | Best for |
|---|---|---|---|
| `github-coding-agent` | GitHub MCP `create_pull_request_with_copilot` / `assign_copilot_to_issue`, or `gh agent-task create` | cloud (own VM + branch + PR) | **PREFERRED** for isolated one-shot issues |
| `claude-subagent` | Claude Code `implementer` agent in a git worktree | local worktree | issues adjacent to shared files, fast feedback loops |
| `codex-cloud` | Codex cloud task on the repo | cloud | isolated issues when running under Codex |
| `cursor-background` | Cursor background agent | background VM | isolated issues when running under Cursor |
| `sequential-fallback` | coordinator implements issues itself, one at a time | none | no delegation capability detected |

**Detection procedure** (run once per session, cache the result in the state file):

1. Environment: `CLAUDECODE` → Claude Code; `CODEX` → Codex; `CURSOR_AGENT` → Cursor;
   `CI_AGENT` or `CI` → headless automation (prefer cloud backends; no interactive prompts).
2. Capability probes, cheapest first: GitHub MCP coding-agent tools present in the tool list?
   `gh agent-task --help` exits 0? Harness-native subagent spawning available (Claude Code
   `Task`/`Agent` tooling, Cursor background agents)?
3. Anything that fails its probe is out of the matrix for this session. If everything fails,
   use `sequential-fallback` — the loop must degrade, not stop.

**Selection rule per issue:** an issue is *isolated* when its acceptance checklist expects no
`cascadeDeltas` outside its own package scope and touches no coordinator-owned shared files
(registries, ledgers, traceability, state files). Isolated → the best available cloud backend
(cloud is preferred: it cannot collide with the coordinator's working tree). Not isolated →
local `claude-subagent` worktree when available, else keep it coordinator-only. When no cloud
backend probes true, isolated issues fall back to local worktrees, then to sequential.

## Claim protocol (race-free by construction)

The COORDINATOR owns all Linear state. Per issue, in order:

1. Set the issue's assignee + state → In Progress (coordinator, before any spawn/assignment).
2. Dispatch via the selected backend with the issue id, full one-shot body, and the acceptance
   checklist. **Branch names are requested, not assumed**: ask for `sdlc/<issue-id>-<slug>`,
   but record whatever branch the backend actually created in the state file — cloud agents
   may impose their own naming. Implementation agents get ZERO Linear access and never edit
   shared files.
3. On completion the agent hands back one report (schema below) via the transport that matches
   its backend.
4. Independent verification: for local worktrees spawn the `reviewer` subagent (read-only) on
   the worktree with the same checklist; for cloud PRs run the same checklist against the PR
   diff and re-run the gates on a local checkout of the PR branch.
5. **Done rule:** move the issue to Done only when ALL hold:
   (a) GitHub reports the PR checks green — query it yourself; never trust the report for
   this — **or** a written billing-budget exception applies to a specific check,
   (b) the independent review pass succeeds (including rubber-duck + adversarial thinking on
   the parent for stack closeout),
   (c) all PR comments and review threads are addressed,
   (d) the PR is squash-merged (stack-aware merge when part of a stack).
   For design-relevant work, also require current-head exact-six unanimous
   designer consensus, no unresolved hard blocker, and deterministic
   `assert-yay`. Billing exceptions apply only to CI and never waive consensus.
   Otherwise: send findings back through the same backend (same worktree / PR-comment
   instructions to the coding agent), or re-plan the issue.
6. Apply `cascadeDeltas` yourself, serially: traceability rows, ledgers, registries, GAPS-style
   registers, Linear comments. Append the outcome (success/failure + failure class + contract
   defect if any) to `.sdlc/dispatch-log.md`.

## Handback: one schema, two transports

Schema (JSON):
`{issue, branch, prUrl?, gates:[{name,pass}], cascadeDeltas:[{file,change}], requirementChanges:[...]}`

- **Local transport** — `claude-subagent` worktrees write `.sdlc/report.json` at the worktree
  root.
- **Cloud transport** — coding agents embed the same JSON in a fenced ` ```sdlc-report ` code
  block in the PR body (or a PR comment when the body is not editable).

Parse rule for cloud handbacks: take the LAST ` ```sdlc-report ` block in the PR body; if the
body has none, take the block from the NEWEST PR comment. A coding-agent PR with no block at
all is non-compliant: comment on the PR asking for the report, and do not move the issue past
In Progress on the strength of the diff alone.

## Resume / reconcile (on every session entry with live state)

- Sweep four sources against the state file: `git worktree list`, Linear In-Progress issues,
  open PRs whose title/body/branch references an `sdlc/<issue-id>` or issue identifier
  (coding-agent PRs included), and recorded dispatches.
- In-Progress issue with no live worktree AND no open PR → back to Todo with a comment; prune
  orphan worktrees (`git worktree prune` for stale metadata only — never delete user work).
- Un-ingested handback (a `.sdlc/report.json` in a surviving worktree, or an unprocessed
  `sdlc-report` block on an open PR) → ingest before dispatching anything new.

## Parallelism

Cap concurrent local implementers so their scopes never share a package; cloud dispatches are
isolated by construction but still count against the per-package exclusivity rule (never two
agents on one package). Shared-file work is coordinator-only, which removes the usual
merge-conflict class by construction.

## Subagent incremental checkins

Every implementer brief **must** require incremental commits (see SKILL.md and
`stacked-prs.md`):

- Commit after each red→green step; never one mega-commit at the end.
- `pnpm agent:check -- --staged` before every commit.
- Conventional, scoped messages.
- Push/hand back often enough that a dead subagent does not lose the layer.

Parent owns stack submit/sync/merge. Subagents do not restructure stacks.

## Stack topology (multi-issue / multi-phase)

When the plan has 2+ dependent issues or phases, the coordinator opens a **GitHub stack** with
`gh stack` **before or as** layers are filled (see `stacked-prs.md`):

1. Plan branch names `sdlc/<id>-NN-<slug>` in dependency order (foundations bottom).
2. `gh stack init` / `gh stack add` for layers; dispatch each implementer onto its branch.
3. `gh stack submit --auto --open` when layers are ready for review.
4. Record stack number + PR URLs in `sdlc-state.md`.
5. On mid-stack fixes: lower branch commit → `gh stack rebase --upstack` → push/sync.

Single-issue work may stay a single PR. Multi-step work **must** stack.

## Closeout (parent, after implementation)

The Done rule is not complete until the parent finishes **bottom-up closeout** for every PR it
opened (`stacked-prs.md` § Bottom-up closeout):

1. Bottom PR first: rubber-duck + adversarial review + independent reviewer.
2. Refresh acceptance evidence and run the designer council when relevance
   detection requires it. Any nay becomes the next implementer handback;
   re-review and reconvene after the fix.
3. Address **all** PR comments and review threads.
4. Fix required status checks that actually ran and failed for code reasons. If checks are red
   only for **billing/budget/quota** (jobs never started / spending limit), document on the PR
   and **still squash-merge** — do not wait for green CI.
5. Re-run current-head `assert-yay` for relevant work. Any post-council
   commit/effective-diff change invalidates approval.
6. Squash-merge that PR (`gh stack merge <pr> --yes --squash` or `gh pr merge <pr> --squash`;
   `--admin` if protection blocks on billing-red checks), then `gh stack sync`.
7. Repeat upward until the stack is fully merged. Recompute each upper layer's
   effective proposal digest after lower-layer merge/rebase and reconvene if it changed.

Never mark the initiative Done while open PRs remain with unresolved comments, failing
**non-billing** checks, or missing squash-merge. Billing-red CI alone is not a Done blocker.
