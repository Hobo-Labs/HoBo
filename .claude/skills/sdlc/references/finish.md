---
type: Agent Skill Reference
title: "SDLC --finish session land"
description: "Session finish protocol: commit local work, rebase on latest trunk, open/update PRs, bottom-up closeout, squash-merge every session PR."
tags: [hobo, sdlc, finish, pr, squash-merge, closeout]
timestamp: 2026-07-31T00:00:00Z
---

# `--finish` — land the current working session

When the user invokes **`/sdlc --finish`**, **`sdlc --finish`**, or clearly asks to
**finish / land / ship the session** under the sdlc skill, the coordinator **stops opening
new product work** and runs this protocol to completion: commit remaining work, get latest
trunk, resolve conflicts, open or update PRs, push, bottom-up review, and **squash-merge
every PR belonging to this session**.

`--finish` is **authorization to push, open/update PRs, and squash-merge** for session work.
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
- Branches already fully squash-merged into `origin/main`.

If the session PR set is empty and the tree is clean relative to `origin/main`, report
**nothing to finish** and stop.

## Hard rules

1. **No force-push** unless the user explicitly ordered it for that branch.
2. **Never commit secrets** (`.env`, keys, tokens). Prefer env var **names** only.
3. **Never delete user work** (`git clean -fdx`, wipe unrelated branches).
4. **`pnpm agent:check -- --staged`** before every commit; never bypass hooks.
   Checkin gates are **local only** (agent hooks + `.githooks`). Do **not** wait
   on, cancel, re-request, or otherwise drive GitHub Action runners for gates
   or site promote (`gh run …`, `POST …/pages/builds`, polling
   `pages-build-deployment`, etc.).
5. **Rebase on `origin/main`** (or the stack base) before open/update PR; resolve conflicts fully.
6. **Bottom-up closeout** for stacks (`stacked-prs.md`); single PR uses the same review steps.
7. **If Actions happen to fire and are billing-red**, that does **not** block
   squash-merge (document + merge; `--admin` if needed). Do not treat green CI
   as a required gate.
8. **Real local gate failures** (`agent:check` / hooks) must be fixed before
   merge — not papered over.
9. Update **`sdlc-state.md`** + append **`.sdlc/dispatch-log.md`** with outcomes.
10. Prefer **one coherent delivery branch** for uncommitted sequential-fallback work; use
    `gh stack` when 2+ dependent layers remain open.
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
4. Commit with conventional, scoped message(s). Multiple small commits OK; squash at merge.
5. If already mid-stack, commit on the **correct layer branch**, then
   `gh stack rebase --upstack` when lower layers change.

If only unpushed commits exist, skip staging; still rebase before push.

### 2. Get latest + resolve conflicts

```bash
git fetch origin
# single branch:
git rebase origin/main
# stack:
gh stack sync    # or rebase onto updated trunk per gh-stack skill
```

On conflict:

1. Resolve files completely (no conflict markers left).
2. `git add` resolved paths; continue rebase (`git rebase --continue` or
   `gh stack rebase --continue`).
3. Re-run the narrowest gates (`pnpm agent:check -- --staged` for conflict-fix commits;
   `pnpm agent:check -- --base=origin/main` only if intentionally validating the whole branch).
4. Do **not** abort and abandon session work without telling the user.

### 3. Push + open or update PRs

**Single-layer:**

```bash
git push -u origin HEAD
# open if none:
gh pr create --title "…" --body "…"
# or update existing:
gh pr view --json number,url,state
```

**Stack:**

```bash
gh stack submit --auto --open
gh stack view --json
```

PR body should include: why, what, test plan, initiative/state link if any, and for cloud
handbacks a fenced `sdlc-report` when applicable.

Record PR numbers in `sdlc-state.md`.

### 4. Session-wide closeout (every PR in the set)

Process PRs **bottom-up** if stacked; otherwise one-by-one (oldest/base first if dependent).

For **each** PR:

1. Rubber-duck the diff (problem, approach, files, tests, risks, rollback).
2. Adversarial pass (security/tenancy, contracts, cascade, over-engineering, shared-file leaks).
3. Independent review (spawn `reviewer` or re-run acceptance + gates yourself).
4. Determine design relevance from paths/acceptance tags, explicit requests,
   or prior council state. A purely internal exemption must be machine-readable
   and justified. For relevant work, refresh current-head evidence and run or
   resume the exact-six council; nay routes to rework and then repeats review,
   evidence, and council.
5. Resolve **all** PR comments/threads.
6. Status checks:
   - Fix real failures; push; re-check.
   - Billing/budget empty-step failures → document on PR + state → **still merge**.
7. For relevant work, run `consensus-loop.mts --mode assert-yay` against
   current HEAD and the current proposal manifest immediately before merge.
   Any post-consensus commit, rebase, effective-diff change, acceptance change,
   or evidence refresh makes approval stale and requires reconvening.
8. Squash-merge:
   ```bash
   # stack layer:
   gh stack merge <pr> --yes --squash
   # single:
   gh pr merge <pr> --squash --delete-branch
   # protection + billing-red:
   gh pr merge <pr> --squash --delete-branch --admin
   ```
9. After each merge: `git fetch origin`; for stacks `gh stack sync --prune`; rebase remaining
   session branches onto new trunk before merging the next. Recompute affected
   upper-layer proposal digests and rerun council approval when they changed.

Repeat until **every** PR in the session set is MERGED (or explicitly closed with a recorded
reason the user accepted).

### 5. Finalize state

1. `sdlc-state.md` → phase `closed` (or remaining true external blocks listed).
2. Append `.sdlc/dispatch-log.md` with PR numbers, merge SHAs, failure classes
   (`billing-budget`, etc.).
3. If state/log changes remain uncommitted after merges, open a **tiny follow-up PR** (or
   include them in the last layer if not yet merged) — do not leave closed-initiative state
   only local.
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

- [stacked-prs.md](stacked-prs.md) — bottom-up closeout detail, billing exception
- [dispatch.md](dispatch.md) — Done rule, handback, resume/reconcile
- `repo` skill `references/git-pr.md` — single-PR hygiene
- Companion skill `gh-stack` — non-interactive `gh stack` CLI
