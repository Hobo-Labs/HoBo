---
type: Agent Skill Reference
title: "SDLC --finish session land"
description: "Session finish protocol: commit local work, merge latest trunk in, supersession check, open/update the one workstream PR, combined-diff closeout, land with a merge commit (never squash)."
tags: [hobo, sdlc, finish, pr, merge-commit, closeout]
timestamp: 2026-07-31T00:00:00Z
---

# `--finish` — land the current working session

When the user invokes **`/sdlc --finish`**, **`sdlc --finish`**, or clearly asks to
**finish / land / ship the session** under the sdlc skill, the coordinator **stops opening
new product work** and runs this protocol to completion: commit remaining work, get latest
trunk, resolve conflicts, close superseded PRs, open or update the workstream PR, push,
review the combined diff, and **land all work belonging to this session with a merge commit**
(never squash, never rebase-merge).

`--finish` is **authorization to push, open/update PRs, close superseded PRs, and merge** for session work.
Do not re-ask for merge permission unless a safety rule would be violated (secrets, force-push,
deleting user work, non-billing CI red that cannot be fixed).

## Scope: what “this session” means

Collect the **session PR set** (union of):

1. **Open PRs** authored or last-updated by the current agent/user whose head branch was
   created or heavily edited in this conversation (branch names, PR numbers already in chat,
   titles matching the initiative).
2. **Branches** with unpushed commits from this session (`git branch -vv`, remotes, stack).
3. **Dirty working tree** changes produced this session (tracked/untracked product files).
4. **Stack layers** recorded in `.sdlc/<initiative>/sdlc-state.md` still open.
5. **Cloud dispatches** still open for this initiative (handback PRs in state / dispatch-log).

Exclude:

- Unrelated open PRs the agent did not touch this session.
- Local-only noise (e.g. `.serena/`, `.env`, secrets, user WIP unrelated to the initiative).
- Branches whose head is already in `origin/main` (`git merge-base --is-ancestor <head> origin/main`).

If the session PR set is empty and the tree is clean relative to `origin/main`, report
**nothing to finish** and stop.

## Hard rules

1. **No force-push** and **no rebase of a pushed branch**. Update with trunk by merging it in.
2. **Never commit secrets** (`.env`, keys, tokens). Prefer env var **names** only.
3. **Never delete user work** (`git clean -fdx`, wipe unrelated branches).
4. **`pnpm agent:check -- --staged`** before every commit; never bypass hooks.
   Checkin gates are local, but they do not replace GitHub's required merge
   checks. During authorized closeout, follow required checks and the merge
   queue through completion, fix real failures, and recheck changed heads. Do
   independent work while checks run when possible; do not cancel or rerun
   unrelated jobs or trigger site promotion merely for a local check-in.
5. **Merge `origin/main` in** (`git merge origin/main`) before open/update PR; resolve conflicts fully.
6. **Stack closeout** (`stacked-prs.md`): review the whole stack's combined diff against trunk
   once and land the top PR as one unit; a single PR uses the same review steps.
   **Never `--squash`, never `--rebase`** — land with `gh pr merge <n> --merge` or the merge
   queue with the merge-commit method.
7. **If checks are billing-red**, follow the documented billing exception
   (document + merge; `--admin` if needed). Otherwise, respect required
   GitHub status checks and the merge queue.
8. **Real local gate failures** (`agent:check` / hooks) must be fixed before
   merge — not papered over.
9. Update **`sdlc-state.md`** + append **`.sdlc/dispatch-log.md`** with outcomes.
10. Prefer **one coherent delivery branch** for uncommitted sequential-fallback work; use
    `gh stack` layers when 2+ dependent layers remain, still with **one PR** for the stack.
    **WIP limit:** a workstream has at most one open PR.
11. **`--finish` cannot bypass designer consensus.** Deterministically detect
    design-relevant session PRs, run or resume the exact-six council, rework on
    nay, and reject stale approval. Billing-only CI exceptions do not waive it.

## Algorithm (run in order)

### 0. Probe

```bash
git fetch origin
git status -sb
git branch --show-current
gh stack view --json 2>/dev/null || true
gh pr list --author @me --state open --limit 30
```

Read `.sdlc/*/sdlc-state.md` for in-flight initiatives. Build the session PR set.

### 1. Stabilize local work (uncommitted / unpushed)

If there are intentional uncommitted changes:

1. Ensure a **delivery branch** (not bare `main` if policy forbids committing to main):
   ```bash
   git fetch origin
   # if on main or a dead closed branch:
   git checkout -b feat/<short-slug>   # or sdlc/<initiative>-NN-<slug>
   ```
2. Stage deliberately (no secrets, no `.serena/`, no unrelated noise).
3. `pnpm agent:check -- --staged` — fix failures; re-stage.
4. Commit with conventional, scoped message(s). Multiple small commits OK; they land as-is.
5. If already mid-stack, commit on the **correct layer branch**, then merge it up to the
   layers above (`gh stack rebase --upstack` only while those layers are unpushed).

If only unpushed commits exist, skip staging; still merge latest trunk in before push.

### 2. Get latest + resolve conflicts

```bash
git fetch origin
# branch or top of stack:
git merge origin/main
# fully unpushed local stack only:
gh stack sync
```

On conflict:

1. Resolve files completely (no conflict markers left).
2. `git add` resolved paths; conclude the merge (`git commit`, or `gh stack rebase --continue`
   for an unpushed stack).
3. Re-run the narrowest gates (`pnpm agent:check -- --staged` for conflict-fix commits;
   `pnpm agent:check -- --base=origin/main` only if intentionally validating the whole branch).
4. Do **not** abort and abandon session work without telling the user.

### 3. Supersession check

For every branch and open PR in the session set:

```bash
git merge-base --is-ancestor <head> origin/main && echo "already landed"
gh pr list --state open --json number,headRefOid,headRefName
git merge-base --is-ancestor <head> <other-open-pr-head> && echo "superseded"
```

If a head is already in `origin/main` or is an ancestor of another open PR's head, do not open
or keep a separate PR for it — close it with `Superseded by #N` (keep the branch):

```bash
gh pr close <n> --comment "Superseded by #N"
```

### 4. Push + open or update the workstream PR

One PR per workstream — the top of the stack, or the single branch — based on `main` and
opened **ready for review**, not as a draft. If the workstream already has an open PR, push
commits to it instead of opening another.

```bash
git push -u origin HEAD
# open if none:
gh pr create --base main --title "…" --body "…"
# or update existing:
gh pr view --json number,url,state
```

PR body should include: why, what, the layers in order (if stacked), test plan,
initiative/state link if any, and for cloud handbacks a fenced `sdlc-report` when applicable.

Record PR numbers in `sdlc-state.md`.

### 5. Session-wide closeout (every workstream PR in the set)

Review each workstream's **combined diff against trunk** (`git diff origin/main...<top>`)
once; do not review or merge stack layers one at a time.

For **each** workstream PR:

1. Rubber-duck the combined diff (problem, approach, files, tests, risks, rollback).
2. Adversarial pass (security/tenancy, contracts, cascade, over-engineering, shared-file leaks).
3. Independent review (spawn `reviewer` or re-run acceptance + gates yourself).
4. Determine design relevance from paths/acceptance tags, explicit requests,
   or prior council state. A nonvisual exemption must be machine-readable and
   justified; technical contracts and documentation still need independent
   review and appropriate validation. For relevant work, refresh evidence and run or
   resume the exact-six council; nay routes to rework and then repeats review,
   evidence, and council.
5. Resolve **all** PR comments/threads.
6. Status checks:
   - Follow required checks and queued merges until GitHub reports the PR merged;
     a queued PR is not yet merged.
   - Fix real failures; push; re-check.
   - Billing/budget empty-step failures → document on PR + state → **still merge**.
7. For relevant work, run `consensus-loop.mts --mode assert-yay` against
   current HEAD and the current proposal manifest immediately before merge.
   Any post-consensus commit, trunk merge, effective-diff change, acceptance change,
   or evidence refresh makes approval stale and requires reconvening.
8. Land with a merge commit (retarget the top PR to `main` first if needed):
   ```bash
   gh pr edit <pr> --base main
   gh pr merge <pr> --merge
   # protection + billing-red:
   gh pr merge <pr> --merge --admin
   ```
   Never `--squash`, never `--rebase`. Lower layers' commits are now in `main`, so their PRs
   are marked merged automatically; close any that remain with `Superseded by #N`.
9. After each merge, fetch the new trunk and merge it into the remaining session
   branches (`git merge origin/main`) before merging the next. Never rebase a pushed
   branch, force-push, or prune user branches. Recompute affected proposal digests and
   rerun council approval when they changed.

Repeat until **every** PR in the session set is MERGED (merge commit), closed as superseded, or
explicitly closed with a recorded reason the user accepted.

### 6. Finalize state

1. `sdlc-state.md` → phase `closed` (or remaining true external blocks listed).
2. Append `.sdlc/dispatch-log.md` with PR numbers, merge SHAs, failure classes
   (`billing-budget`, etc.).
3. Keep `.sdlc/` state and logs local and ignored. The PRs and any existing
   issue-tracker records are the durable history; do not open a follow-up PR
   solely to commit ignored state.
4. Report to the user: PR URLs, merge SHAs, billing exceptions, residuals.

## Partial finish / blocked finish

| Situation | Action |
|---|---|
| Conflict needs product decision | Resolve if obvious; else stop with conflict paths + options |
| Real CI red, fix known | Fix in same session, push, re-merge attempt |
| Real CI red, blocked on user | Leave PR open with comment; state `blocked`; still land other independent session PRs |
| No push rights / protection without admin | Report; do not claim Done |
| Empty session set | Report nothing to finish |

`--finish` **attempts** full completion. It is not allowed to stop early solely because
“CI is red” when the red is billing-only, or because “merge usually needs a human” when the
user already passed `--finish`.

## Relationship to other phases

| Flag / mode | Behavior |
|---|---|
| bare `/sdlc` | Full loop from brainstorm (or resume state) |
| `/sdlc --finish` | **Skip** new brainstorm/plan/dispatch unless needed to land; run this finish protocol |
| Closeout after dispatch | Same merge steps as here; `--finish` also scoops **uncommitted** work and **all** session PRs |

## Invocation examples

```text
/sdlc --finish
sdlc --finish
/sdlc finish
"finish the session" / "land everything" / "commit push pr merge" under an sdlc conversation
```

## Related

- [stacked-prs.md](stacked-prs.md) — stack closeout detail, supersession check, billing exception
- [dispatch.md](dispatch.md) — Done rule, handback, resume/reconcile
- `repo` skill `references/git-pr.md` — single-PR hygiene
- Companion skill `gh-stack` — non-interactive `gh stack` CLI
