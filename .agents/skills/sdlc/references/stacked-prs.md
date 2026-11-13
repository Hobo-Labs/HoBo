---
type: Agent Skill Reference
title: "SDLC stacked PRs"
description: "Parent-owned GitHub stacked PRs via gh stack: layer planning, subagent incremental checkins, sync, bottom-up rubber-duck/adversarial review, comment and check repair, squash-merge per PR."
tags: [hobo, sdlc, stacked-prs, gh-stack, review, merge]
timestamp: 2026-07-30T00:00:00Z
---

# Stacked PRs (parent protocol)

Multi-step / multi-phase / multi-task work in this repo ships as a **stack of pull requests**
managed with GitHub's official extension:

```bash
gh extension install github/gh-stack   # once; setup-agent-tools.sh installs it in common layer
```

Docs: https://gh.io/stacks · Companion agent skill: `gh-stack` (CLI non-interactive rules).

The **parent/coordinator** owns stack topology. Subagents commit on the branch for their layer;
they do not restructure or merge the stack.

## When to stack

| Situation | Action |
|---|---|
| 2+ dependent phases, packages, or issues | **Stack** — one layer per phase/issue |
| Foundational types/contracts then consumers | Stack — foundation at **bottom** |
| Unrelated bugfix mid-feature | **Separate** stack or standalone PR |
| Single atomic issue | Single branch + PR is fine |

## Layer planning (before code)

Order layers by **dependency**, bottom → top:

```text
main (trunk)
 └── 01-contracts-schema     # protos, CUE, generated types
  └── 02-core-impl           # pure logic on those types
   └── 03-runtime-adapter    # storage/runtime wiring
    └── 04-dx-cli-proof      # CLI / draft proofs / experience
```

Name branches for agents and humans:

```text
sdlc/<initiative-or-issue>-NN-<slug>
```

Record the planned chain in `.sdlc/<initiative>/sdlc-state.md` before dispatch.

## Non-interactive agent rules (mandatory)

Never hang on a TUI or prompt:

| Do | Do not |
|---|---|
| `gh stack init branch-a` | bare `gh stack init` |
| `gh stack add branch-b` | bare `gh stack add` |
| `gh stack submit --auto` (`--open` when ready) | `gh stack submit` without `--auto` |
| `gh stack view --json` | `gh stack view` / `--short` |
| `gh stack checkout <pr\|branch\|stack#>` | bare `gh stack checkout` |
| `gh stack merge <pr#> --yes --squash` | bare interactive `gh stack merge` / wrong `gh pr merge` on stacks |

Git defaults (local):

```bash
git config --local rerere.enabled true
git config --local remote.pushDefault origin
```

## Parent workflow

### 1. Create the bottom layer

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
gh stack init sdlc/<id>-01-<slug>
```

Dispatch a subagent onto this branch (worktree or cloud). Subagent rules: **incremental checkins**.

### 2. Add upper layers as work proceeds

Only from the **top** of the stack, after the lower layer has at least one good commit:

```bash
gh stack top
gh stack add sdlc/<id>-02-<slug>
# dispatch next subagent on this branch
```

You may pre-create empty layers with `gh stack init a b c` if the plan is stable; still keep
commits concern-scoped per branch.

### 3. Subagent incremental checkins

Instruct every implementer:

1. Red tests → green minimal fix → commit (small steps).
2. `pnpm agent:check -- --staged` before every commit.
3. Conventional commits; multiple commits per layer expected.
4. Never edit coordinator-owned shared files; report `cascadeDeltas`.
5. Do not run `gh stack merge` / `gh stack unstack` / restructure.
6. Hand back `.sdlc/report.json` (and `sdlc-report` block if PR-facing).

Parent may `gh stack push` periodically so layers are remote-backed.

### 4. Submit the stack

```bash
gh stack submit --auto --open
gh stack view --json
```

Edit PR bodies after submit if needed (`gh pr edit`) — include initiative link, layer purpose,
acceptance summary, and for cloud handbacks the `sdlc-report` fence.

Update `sdlc-state.md` with stack number, branch order, PR URLs.

### 5. Mid-stack fixes

If an upper layer needs a lower-layer change:

```bash
gh stack checkout <lower-branch-or-pr>
# fix + commit
gh stack rebase --upstack
gh stack push
# or: gh stack sync
```

Do **not** land lower-layer fixes as commits on the upper branch.

### 6. Sync after trunk or merges

```bash
gh stack sync
# after merges, prune local merged branches when safe:
gh stack sync --prune
```

Exit code 3 = rebase conflict: resolve files, `git add`, `gh stack rebase --continue`
(or `--abort`). Exit code 9 = stacks not enabled on the repo — stop and tell the user.

## Bottom-up closeout (required)

When implementation for the initiative is complete, the parent **must** close every opened PR
from the **bottom up**. This is not optional.

### Per-PR checklist (bottom → top)

For PR at index `i` (bottom first):

1. **Checkout the layer**
   ```bash
   gh stack checkout <pr-number>
   gh stack view --json
   ```

2. **Rubber-duck mode**
   - State the problem this layer solves.
   - Walk the change file-by-file: what, why, how tested.
   - Name invariants, contracts (PACT/proto/CUE), and rollback.
   - Any step you cannot explain plainly → fix or split before merge.

3. **Adversarial thinking**
   - Abuse / tenancy / secret leakage.
   - Contract breaks, effect widening, event-store concurrency.
   - Missing draft artifacts / cascade updates.
   - Over-engineering (`ponytail` lens).
   - Shared-file edits that should have been cascade deltas.
   - Silent test skips or gate bypasses.

4. **Independent review**
   - Spawn `reviewer` subagent or re-run acceptance checklist + relevant gates yourself.
   - Query GitHub checks yourself; never trust implementer "green" alone.

5. **Current-head designer council when relevant**
   - Classify changed paths and acceptance tags deterministically. A non-design
     exemption is machine-readable and justified; a prior council cycle always
     makes the layer relevant.
   - Refresh current-head acceptance/evidence manifests, compute the proposal
     digest against the layer's effective base, then run or resume the exact six
     personas through the append-only OptimizeXP council.
   - Any nay appends a rework packet and returns to implementation. Repeat
     independent review → evidence → council after fixes. No majority, quorum,
     timeout, or investment-weighted approval exists.

6. **All PR comments and review feedback**
   ```bash
   gh pr view <n> --comments
   gh api repos/{owner}/{repo}/pulls/<n>/comments
   gh api repos/{owner}/{repo}/pulls/<n>/reviews
   ```
   - Fix code for every actionable thread, or reply with a justified non-action.
   - Resolve threads after addressing.
   - Re-request review if human reviewers are in the loop.

7. **Status checks**
   - Wait for required checks **when runners can start**.
   - On real (code) failure: fix on this layer, commit, `gh stack push` / `gh stack sync`, re-check.
   - **Billing / budget / quota — do not block merge:**
     Signals: jobs fail in seconds with **no runner**, empty steps, annotations like
     "spending limit needs to be increased", "recent account payments have failed",
     exhausted minutes/quota, CodeRabbit/plan rate limits (review tooling only — not a merge gate).
     Actions:
     1. Comment the exact billing message + check names on the PR.
     2. Record `billing-budget` in `sdlc-state.md` / dispatch-log.
     3. **Proceed to squash-merge now.** Do not wait for green CI. Do not treat this as a
        "user decision" gate for the merge — the agent **is still expected to squash-merge**
        when review + comments are clean and the only red checks are billing.
     4. Prefer `gh stack merge <n> --yes --squash` or `gh pr merge <n> --squash`. Use
        `--admin` only if branch protection still demands green checks and the token can
        override. If even admin merge is denied, report the protection block; never leave the
        PR indefinitely open "waiting on CI that cannot run."
     5. This exception **never** covers failing tests, lint, architecture, secret-scan content
        findings, or any check that actually executed and found a defect.

8. **Assert and squash-merge this PR**
   - For design-relevant work, run deterministic `assert-yay` against the exact
     current HEAD and proposal manifest immediately before merge. A comment fix,
     check repair, rebase, changed acceptance/evidence digest, or effective-base
     change after approval makes it stale and requires refreshed evidence plus a
     new council cycle. Billing-only CI exceptions do not waive this assertion.
   ```bash
   gh stack merge <pr-number> --yes --squash
   # single PR: gh pr merge <pr-number> --squash --delete-branch
   # billing-red + protection: gh pr merge <pr-number> --squash --delete-branch --admin
   gh stack sync --prune
   ```
   Prefer merging **one PR at a time** after its review so the next layer rebases onto real trunk
   history (especially after squash-merge). Do not leave comments unresolved "for later."

9. Advance to the next PR up the stack. After each lower squash-merge and sync,
   recompute every affected upper layer's effective proposal digest and rerun
   council review if it changed. Repeat until none remain.

### Stack-complete criteria

- Every PR the parent opened is MERGED (squash) or explicitly closed with user approval.
- `gh stack view --json` shows no open unmerged work (or stack fully pruned).
- Linear/issue tracker: each issue Done only under the Done rule (checks + review + merge).
- `.sdlc/dispatch-log.md` and `sdlc-state.md` updated with outcomes.
- Each design-relevant layer records its council review ID, consensus entry,
  proposal digest, reviewed head, cycle, and final assertion time.
- Workspace cleaned per `repo` skill when appropriate.

## Done rule (stack-aware)

A layer is Done only when **all** hold:

1. Independent review pass succeeds (rubber-duck + adversarial + reviewer).
2. All PR review comments/threads addressed.
3. Required status checks green **or** only billing/budget failures remain, documented on the PR.
4. PR **squash-merged** (stack-aware merge when in a stack). Billing-red CI is not a leave-open state.
5. Cascade deltas applied by the coordinator.
6. Issue tracker moved to Done by the coordinator (never by the implementer).
7. For design-relevant work, exact-six unanimous approval binds the current
   proposal digest and HEAD, no blocker is open, and `assert-yay` passes. The
   billing exception waives only CI; it never waives council consensus.

## Failure classes (for dispatch-log)

| Class | Meaning | Next action |
|---|---|---|
| `stack-disabled` | exit 9 / stacks not enabled | User enables stacks or fall back to sequential PRs with manual base branches |
| `rebase-conflict` | exit 3 | Parent resolves; re-dispatch only if logic conflict needs implementer |
| `review-fail` | adversarial/rubber-duck/reviewer found defects | Re-dispatch fix on same layer |
| `checks-fail` | CI red (non-billing) | Fix on layer, push, re-wait |
| `billing-budget` | quota/minutes/spending limit; jobs never ran | Document on PR + state; **squash-merge now**; notify user that account billing needs repair (async) |
| `comments-open` | unresolved threads | Address before merge |
| `handback-missing` | no `sdlc-report` / report.json | Demand report; do not Done |

## Coordination with cloud backends

When layers are implemented by cloud coding agents that open their own branches/PRs:

1. Prefer giving them the **pre-created stack branch** as the head.
2. If they open free-standing PRs, parent `gh stack link`s them in dependency order (or
   re-bases onto the stack) before closeout.
3. Handback remains the fenced `sdlc-report` block; parent still owns bottom-up merge.

## Related

- `finish.md` — `/sdlc --finish` session land (commit + all session PRs through squash-merge)
- `dispatch.md` — backend matrix, claim protocol, handback schema
- `loops-and-gates.md` — red/green and agent:check ladder
- `repo` skill `references/git-pr.md` — single-PR hygiene (stacks supersede for multi-layer)
- Companion skill `gh-stack` — full non-interactive CLI reference
