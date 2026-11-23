---
type: Agent Skill Reference
title: "SDLC stacked PRs"
description: "Parent-owned gh stack layers landed as one unit: layer planning, subagent incremental checkins, one workstream PR, supersession check, combined-diff rubber-duck/adversarial review, comment and check repair, merge-commit landing (never squash)."
tags: [hobo, sdlc, stacked-prs, gh-stack, review, merge]
timestamp: 2026-07-30T00:00:00Z
---

# Stacked PRs (parent protocol)

Multi-step / multi-phase / multi-task work in this repo is organized as a **stack of layer
branches** managed with GitHub's official extension, and lands as **one unit** through **one
PR** — the top of the stack:

```bash
gh extension install github/gh-stack   # once; setup-agent-tools.sh installs it in common layer
```

Docs: https://gh.io/stacks · Companion agent skill: `gh-stack` (CLI non-interactive rules).

The **parent/coordinator** owns stack topology. Subagents commit on the branch for their layer;
they do not restructure or merge the stack.

## Landing policy

- **Never squash. Never rebase-merge.** Land with a merge commit (`gh pr merge <n> --merge`, or
  the merge queue with the merge-commit method). History is preserved, so descendants of a
  landed branch stay conflict-free and GitHub marks contained PRs merged automatically.
- **A stack lands as one unit.** Layers organize commits and checkins; review covers the whole
  stack's combined diff against trunk (top-of-stack vs `main`), done once.
- **Update with trunk by merging it in** (`git merge origin/main`). Never rebase a pushed
  branch; never force-push. `gh stack rebase` / `gh stack sync` are for unpushed local layers only.
- **One PR per workstream**, opened ready for review — not a PR per layer, not a long-lived
  draft. **WIP limit:** a workstream has at most one open PR; add commits to it instead of
  opening another.
- **Supersession check** before opening a PR and at finish (§ Supersession check).

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
| `gh pr create --base main --head <top-branch>` (ready, not draft) | `gh stack submit` (opens a PR per layer) / `--draft` |
| `gh stack view --json` | `gh stack view` / `--short` |
| `gh stack checkout <pr\|branch\|stack#>` | bare `gh stack checkout` |
| `gh pr merge <top-pr> --merge` | `--squash`, `--rebase`, or merging lower layers one by one |

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
5. Do not open PRs, merge, `gh stack unstack` / restructure, rebase pushed branches, or force-push.
6. Hand back `.sdlc/report.json` (and `sdlc-report` block if PR-facing).

Parent may push layer branches periodically so layers are remote-backed; pushing a branch
does not open a PR for it.

### 4. Open the workstream PR

Run the supersession check, then open **one** PR for the top of the stack against `main`,
ready for review:

```bash
git push -u origin sdlc/<id>-NN-<slug>
gh pr create --base main --head sdlc/<id>-NN-<slug> --title "…" --body "…"
gh stack view --json
```

The PR body lists the layers in order — include initiative link, each layer's purpose,
acceptance summary, and for cloud handbacks the `sdlc-report` fence. If the workstream already
has an open PR, push new commits to it instead of opening another.

Update `sdlc-state.md` with branch order and the PR URL.

### 5. Mid-stack fixes

If an upper layer needs a lower-layer change:

```bash
gh stack checkout <lower-branch>
# fix + commit
# unpushed layers only:
gh stack rebase --upstack
# pushed layers: merge the fix up instead
git checkout <upper-branch> && git merge <lower-branch>
git push
```

Do **not** land lower-layer fixes as commits on the upper branch.

### 6. Update after trunk moves

```bash
git fetch origin
git checkout <top-branch>
git merge origin/main
git push
```

Never rebase a pushed branch and never force-push. `gh stack sync` / `gh stack rebase` apply
only while every affected layer is still unpushed. Exit code 3 = rebase conflict: resolve
files, `git add`, `gh stack rebase --continue` (or `--abort`). Exit code 9 = stacks not enabled
on the repo — stop and tell the user.

### Supersession check

Before opening a PR and again at finish, for each candidate branch head:

```bash
git fetch origin
git merge-base --is-ancestor <head> origin/main && echo "already landed"
gh pr list --state open --json number,headRefOid,headRefName
git merge-base --is-ancestor <head> <other-open-pr-head> && echo "superseded"
```

If the head is in `origin/main` or is an ancestor of another open PR's head, do not open or keep
a separate PR — close it with `Superseded by #N` and keep the branch:

```bash
gh pr close <n> --comment "Superseded by #N"
```

## Stack closeout (required)

When implementation for the initiative is complete, the parent **must** review and land the
stack as **one unit**. This is not optional. Review the combined diff once; do not review or
merge layers one at a time.

### Closeout checklist (whole stack)

1. **Checkout the top of the stack**
   ```bash
   gh stack top
   gh stack view --json
   git fetch origin
   git diff origin/main...HEAD
   ```

2. **Rubber-duck mode**
   - State the problem the stack solves and what each layer contributes.
   - Walk the combined change file-by-file: what, why, how tested.
   - Name invariants, contracts (PACT/proto/CUE), and rollback.
   - Any step you cannot explain plainly → fix before merge.

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
     digest against `main`, then run or resume the exact six
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
   - On real (code) failure: fix on the owning layer, merge it up to the top, push, re-check.
   - **Billing / budget / quota — do not block merge:**
     Signals: jobs fail in seconds with **no runner**, empty steps, annotations like
     "spending limit needs to be increased", "recent account payments have failed",
     exhausted minutes/quota, CodeRabbit/plan rate limits (review tooling only — not a merge gate).
     Actions:
     1. Comment the exact billing message + check names on the PR.
     2. Record `billing-budget` in `sdlc-state.md` / dispatch-log.
     3. **Proceed to merge now.** Do not wait for green CI. Do not treat this as a
        "user decision" gate for the merge — the agent **is still expected to merge**
        when review + comments are clean and the only red checks are billing.
     4. Use `gh pr merge <n> --merge` (never `--squash`). Use
        `--admin` only if branch protection still demands green checks and the token can
        override. If even admin merge is denied, report the protection block; never leave the
        PR indefinitely open "waiting on CI that cannot run."
     5. This exception **never** covers failing tests, lint, architecture, secret-scan content
        findings, or any check that actually executed and found a defect.

8. **Assert and land the stack with a merge commit**
   - For design-relevant work, run deterministic `assert-yay` against the exact
     current HEAD and proposal manifest immediately before merge. A comment fix,
     check repair, trunk merge, changed acceptance/evidence digest, or effective-base
     change after approval makes it stale and requires refreshed evidence plus a
     new council cycle. Billing-only CI exceptions do not waive this assertion.
   ```bash
   gh pr edit <top-pr> --base main      # if it is not already based on main
   gh pr merge <top-pr> --merge
   # billing-red + protection: gh pr merge <top-pr> --merge --admin
   ```
   Never `--squash`, never `--rebase`. Do not leave comments unresolved "for later."

9. **Confirm contained PRs closed.** Lower layers' commits are now in `main`, so GitHub marks
   any lower-layer PRs merged automatically. Close any that remain open with
   `Superseded by #N`.

### Stack-complete criteria

- The workstream PR is MERGED with a merge commit; every other PR the parent opened is merged
  automatically, closed as superseded, or explicitly closed with user approval.
- `gh stack view --json` shows no open unmerged work.
- Linear/issue tracker: each issue Done only under the Done rule (checks + review + merge).
- `.sdlc/dispatch-log.md` and `sdlc-state.md` updated with outcomes.
- Each design-relevant layer records its council review ID, consensus entry,
  proposal digest, reviewed head, cycle, and final assertion time.
- Workspace cleaned per `repo` skill when appropriate.

## Done rule (stack-aware)

A layer is Done only when **all** hold:

1. Independent review pass of the stack's combined diff succeeds (rubber-duck + adversarial + reviewer).
2. All PR review comments/threads addressed.
3. Required status checks green **or** only billing/budget failures remain, documented on the PR.
4. Its commits are in `main` through a **merge commit** (never squash). Billing-red CI is not a leave-open state.
5. Cascade deltas applied by the coordinator.
6. Issue tracker moved to Done by the coordinator (never by the implementer).
7. For design-relevant work, exact-six unanimous approval binds the current
   proposal digest and HEAD, no blocker is open, and `assert-yay` passes. The
   billing exception waives only CI; it never waives council consensus.

## Failure classes (for dispatch-log)

| Class | Meaning | Next action |
|---|---|---|
| `stack-disabled` | exit 9 / stacks not enabled | User enables stacks or fall back to plain layer branches merged up into one top branch |
| `merge-conflict` | conflict merging trunk or a lower layer in (exit 3 for unpushed `gh stack rebase`) | Parent resolves; re-dispatch only if logic conflict needs implementer |
| `superseded` | head in `origin/main` or ancestor of another open PR's head | Close `Superseded by #N`; keep the branch |
| `review-fail` | adversarial/rubber-duck/reviewer found defects | Re-dispatch fix on same layer |
| `checks-fail` | CI red (non-billing) | Fix on layer, push, re-wait |
| `billing-budget` | quota/minutes/spending limit; jobs never ran | Document on PR + state; **merge now** (`--merge`); notify user that account billing needs repair (async) |
| `comments-open` | unresolved threads | Address before merge |
| `handback-missing` | no `sdlc-report` / report.json | Demand report; do not Done |

## Coordination with cloud backends

When layers are implemented by cloud coding agents that open their own branches/PRs:

1. Prefer giving them the **pre-created stack branch** as the head.
2. If they open free-standing PRs, parent merges their branches up into the stack in
   dependency order, then closes the free-standing PRs with `Superseded by #N` (branches kept).
3. Handback remains the fenced `sdlc-report` block; parent still owns the one merge-commit landing.

## Related

- `finish.md` — `/sdlc --finish` session land (commit + all session work through merge-commit landing)
- `dispatch.md` — backend matrix, claim protocol, handback schema
- `loops-and-gates.md` — red/green and agent:check ladder
- `repo` skill `references/git-pr.md` — single-PR hygiene (stacks supersede for multi-layer)
- Companion skill `gh-stack` — full non-interactive CLI reference
