---
name: sdlc
description: Coordinate iterative feature/capability development end to end in this repo — brainstorm with adversarial and rubber-duck hardening, plan through the draft-proof cascade, capture one-shot issues, dispatch subagents with incremental checkins, organize multi-phase work as gh stack layers landed as one unit, then one rubber-duck/adversarial review of the stack's combined diff against trunk, comment resolution, status-check repair, and a merge commit (never squash or rebase-merge) of the top PR. Supports --finish to land the current session (commit, merge latest main in, resolve conflicts, supersession check, open/update the one workstream PR, push, merge-commit landing). Use when the user wants to develop a feature through the full loop, says "sdlc", "run the loop", "stacked PRs", "take this from idea to merge", "sdlc --finish", or "finish the session".
---

# SDLC coordinator

The repository-wide rules at the start of `AGENTS.md` override this skill and its references: implement unfinished work, use self-documenting code, and do not create planning or design documents. Skip any instruction below that requests those artifacts.

Drive a feature or capability through the full development loop **in this repo**. You are the
**parent/coordinator**: you own the conversation with the user, the plan, Linear (or issue tracker)
state, shared-file mutations, **stack topology**, and the final review→merge gate for every PR.

Implementation work is delegated to **subagents** (or cloud coding agents) whenever possible.
Subagents own exactly one issue/layer each, commit incrementally, and never touch Linear or shared
coordinator files. For multi-step / multi-phase / multi-task work, the parent opens a **stack of
PRs** with GitHub's official `gh stack` extension — not one giant PR.

## Flags

| Form | Meaning |
|---|---|
| **(none)** / bare `sdlc` | Full loop: reconcile state → brainstorm (or resume) → plan → issues → dispatch → closeout |
| **`--finish`** / `finish` | **Land the current working session** — no new product brainstorm unless required to ship. Commit remaining work, fetch and merge latest trunk in, resolve conflicts, close superseded PRs, open/update the workstream PR, push, review the combined diff, **land all session work with a merge commit**. Full protocol: `references/finish.md` |

`--finish` is **explicit authorization** to push, open/update PRs, and merge session work
(billing-red CI does not block merge). Safety still applies: no secrets, no force-push, no deleting
user work, fix real CI failures before merge.

## First moves

1. Parse flags. If **`--finish`** (or user clearly wants session land / “commit push PR merge”
   under sdlc): load `references/finish.md` and **run that protocol to completion**. Skip opening
   new brainstorm/plan/dispatch unless finish itself needs a tiny state/docs follow-up PR.
2. Otherwise: durable state first (below), then phases 1–6 as usual.

## Install / probe (once per machine or session)

```bash
# Extension (also installed by scripts/setup-agent-tools.sh common layer)
gh extension install github/gh-stack   # or: gh extension upgrade stack
gh stack --help

# Agent-safe git defaults (also set by scripts/install-hooks.mts / setup script)
git config --local rerere.enabled true
git config --local remote.pushDefault origin
```

If `gh stack` is missing, install it before dispatching multi-layer work. CLI detail lives in the
companion **`gh-stack`** skill (mirrored under `.agents/skills/gh-stack` and `.claude/skills/gh-stack`)
and in `references/stacked-prs.md`. Official docs: https://gh.io/stacks

## Existing state

Complete outstanding work in existing session state before removing it. Do not create or extend planning state.

## Phases (details in references/)

0. **`--finish` (session land)** — `references/finish.md`. When the flag is present, run the
   finish protocol instead of starting a new initiative: commit → latest trunk → conflicts →
   supersession check → one workstream PR → combined-diff closeout → merge commit landing **all session work**. Then stop (or only open a
   tiny state/docs follow-up if still needed).
1. **Brainstorm & harden** — `references/brainstorm.md`. Always start here for new
   features/capabilities. Ideas must survive adversarial + rubber-duck passes before planning.
2. **Implement** — choose the smallest relevant proof layer and complete the requested behavior with executable verification.
3. **Issue capture** — `references/linear-planning.md`. Initiative/projects/milestones/issues,
   each issue a self-contained one-shot contract with verifiable outputs and required draft
   artifacts named explicitly. Prefer **one issue per stack layer**.
4. **Dispatch + stack** — `references/dispatch.md` + `references/stacked-prs.md`. ONLY after
   explicit user permission for offloading. Detect harness backends; claim issues; spawn
   subagents with incremental-checkin rules; parent owns `gh stack init|add` and the one workstream PR.
5. **Loops & cascade** — `references/loops-and-gates.md` + `references/cascade.md`. Red/green
   inner loop, narrow-then-wide outer loop, and machine-checked upward/downward requirement
   cascades.
6. **Close the stack (mandatory)** — `references/stacked-prs.md` § Stack closeout (same
   merge steps as `--finish`, scoped to the initiative stack). When implementation is done, the
   **parent** reviews the **whole stack's combined diff** against trunk once and lands the stack
   as one unit with a merge commit. Do not mark the initiative complete until that PR is
   reviewed, repaired (when repairable), and **merged**.
   Billing/budget-only CI failures do **not** block merge.
   Every design-relevant stack additionally requires the exact-six designer
   council after evidence refresh and another current-head `assert-yay`
   immediately before merge. Any nay returns to implementation; any later
   commit or effective-diff change makes the approval stale.

## Role split

| Actor | Owns | Does not own |
|---|---|---|
| **Parent (this skill)** | User dialogue, plan, Linear, shared files, **stack topology**, the workstream PR, combined-diff review, comments, CI repair, merge-commit landing | Implementing every layer itself when a subagent is available |
| **Subagent / implementer** | One issue/layer, red/green work, **incremental commits**, local gates, handback report | Linear, shared registries, stack restructure, merging PRs |
| **Reviewer subagent** | Independent re-run of gates + acceptance checklist (read-only) | Edits, merges, Linear |

**Leverage subagents hard.** Prefer spawning implementers over doing layer work inline. Cap
concurrency so no two agents share a package. Cloud backends for isolated layers; local worktrees
for shared-file-adjacent layers. Sequential fallback only when no backend probes true.

## Subagent incremental checkins (required)

Every implementer instruction must require **small, frequent commits** — not one dump at the end:

1. After each red→green unit (test + minimal implementation), stage deliberately and commit.
2. Run `pnpm agent:check -- --staged` before **every** commit; never bypass hooks.
3. Conventional, scoped commit messages that describe the step (why if non-obvious).
4. Push / hand back often enough that progress is recoverable if the subagent dies mid-task.
5. Multiple commits per layer are expected and good. Do **not** squash, rebase, or rewrite
   pushed history — commits land on trunk as-is through a merge commit.

The parent may also require the subagent to open or update its layer branch via the branch the
parent created in the stack; the parent alone opens, updates, and merges the workstream PR.

## Stacked layers for multi-step work (parent)

For any work with 2+ dependent phases/tasks, layers organize commits and checkins; the stack
lands as **one unit** through **one PR** (the top layer, based on `main`):

```bash
# Non-interactive only — never hang on prompts/TUIs
gh stack init sdlc/<initiative>-01-<slug>
# ... subagent works + incremental commits on that branch ...
gh stack add sdlc/<initiative>-02-<slug>
# ... next layer ...
gh stack view --json              # always --json for agents
git push -u origin sdlc/<initiative>-02-<slug>
gh pr create --base main --head sdlc/<initiative>-02-<slug> --title "…" --body "…"   # ready, not draft
git merge origin/main             # after trunk moves; never rebase a pushed branch
```

Open **one PR per workstream** — the top of the stack — ready for review, not as a long-lived
draft. Do not open a PR per layer. **WIP limit:** a workstream has at most one open PR; add
commits to it instead of opening another.

**Supersession check** before opening a PR and at finish: if a branch head is already in
`origin/main` or is an ancestor of another open PR's head, do not open or keep a separate PR —
close it with `Superseded by #N` (keep the branch):

```bash
git merge-base --is-ancestor <head> origin/main && echo landed
git merge-base --is-ancestor <head> <other-open-pr-head> && echo superseded
gh pr close <n> --comment "Superseded by #N"
```

Hard agent rules for `gh stack` (summary — full set in `references/stacked-prs.md` + `gh-stack` skill):

- Always pass branch names to `init` / `add` / `checkout` (no bare interactive forms).
- Always `gh stack view --json` (never interactive TUI).
- `gh stack rebase` / `gh stack sync` only for **unpushed** local layers. Once a layer is pushed,
  update it by merging (`git merge origin/main`, or merge the fixed lower layer up); never
  rebase a pushed branch and never force-push.
- **Never squash. Never rebase-merge.** Land with a merge commit (`gh pr merge <top> --merge`,
  or the merge queue with the merge-commit method). Lower layers then show as merged
  automatically because their commits are in `main`.

Single-layer / single-issue work may use a normal PR; multi-step work **must** stack.

## Stack closeout (required for every workstream the parent opened)

When the parent is done dispatching implementation, it **must** review the **whole stack's
combined diff against trunk** (top-of-stack vs `main`) once and land the stack as one unit:

1. **Rubber-duck the combined diff** — explain the change step-by-step as if to a new contributor: problem,
   approach, files, tests, risks, rollback. Anything you cannot justify plainly is a defect.
2. **Adversarial pass** — red-team the combined diff: failure modes, security/tenancy, broken contracts,
   cascade/reg misses, over-engineering, missing gates, silent shared-file edits by subagents.
3. **Independent review** — spawn the `reviewer` (or re-run the acceptance checklist yourself on
   a clean checkout). Do not trust the implementer's self-report.
4. **Designer council when relevant** — deterministically classify the changed
   paths and acceptance tags, refresh evidence, and run or resume the exact-six
   OptimizeXP council. A nay emits rework; repeat implementation → independent
   review → evidence → council until unanimous current-head yay or honest
   blocked termination. A `no-visual-design-change` exemption must be
   machine-readable and justified; technical contracts and documentation still
   require independent review and appropriate validation. Never skip silently.
5. **Comments & review feedback** — list every unresolved PR comment and review thread
   (`gh api` / `gh pr view` / review comments). Address **all** of them: fix code, or reply with
   a reasoned non-action and resolve the thread. Leave no actionable thread open.
6. **Status checks** — wait for required checks when they can run. Repair real failures
   (tests, lint, architecture). Re-run narrow gates after fixes; commit and push (merge
   `origin/main` in when trunk moved) so CI sees the fix.
   - **Billing / budget / quota does not block merge.** If a check fails solely because
     jobs never started or aborted for spending limit, payment failure, exhausted CI minutes,
     runner quota, or similar **non-code** billing signals (empty steps, no runner assigned,
     annotation like "spending limit" / "payments have failed"):
     1. Record the exception on the PR comment + `sdlc-state.md` (which checks, exact message).
     2. **Merge immediately** — do **not** wait for green CI, do **not** stall for user
        approval of the merge itself (user already authorized the workstream; tell them billing
        is broken so they can fix account settings later).
     3. Use `gh pr merge <n> --merge` (never `--squash`). If branch protection still requires
        green checks, retry with `--admin` when the token has that permission. If merge is impossible without elevated rights, say so — still do not
        leave the PR as "waiting on CI" when CI cannot run.
     4. Never use this exception for real test/lint/type failures.
7. **Re-assert designer consensus** for relevant work after all comment/check
   fixes. If HEAD, effective diff, acceptance, or evidence changed, refresh and
   reconvene; do not merge stale approval. Billing exceptions do not waive this.
8. **Land the stack with a merge commit** when review is clean and either checks are green
   **or** only billing-budget failures remain (after documenting them). Retarget the top PR to
   `main` if needed, then:
   ```bash
   gh pr edit <top-pr> --base main
   gh pr merge <top-pr> --merge
   # If protection blocks on billing-red checks and you have admin:
   gh pr merge <top-pr> --merge --admin
   ```
   Never `--squash`, never `--rebase`. Lower layers' commits are now in `main`, so any lower
   layer PRs are marked merged automatically; close any that remain with `Superseded by #N`.

## Hard rules

- Interactive stages (brainstorming, plan approval, dispatch permission) happen in the MAIN
  conversation — subagents cannot ask the user anything.
- One writer per shared file: Linear, `docs/design/traceability.md`, ledgers, registries, GAPS-style
  registers, and the state file are coordinator-only. Implementation agents report deltas via the
  handback schema (`.sdlc/report.json` locally, a fenced `sdlc-report` block on cloud PRs); you
  apply them serially.
- An issue/layer is Done only when (a) GitHub reports the PR checks green — queried by you, not
  taken from the implementation agent — **or** only billing/budget failures remain and are
  documented on the PR + state file, (b) the independent review pass succeeds, (c) all PR
  comments/threads are addressed, and (d) the PR is **merged with a merge commit**. Billing-red CI is not a
  reason to leave a reviewed PR open.
- A design-relevant issue/layer is additionally Done only when the exact six
  canonical personas unanimously approve the current proposal digest and HEAD,
  no hard blocker remains, and deterministic `assert-yay` passes. `/sdlc
  --finish`, a majority, investment exhaustion, or billing-red CI cannot waive
  this gate.
- Perf, contract (PACT), and feature (cucumber) tests are first-class: acceptance criteria become
  failing tests before implementation starts.
- Use this repo's performance-first loop: search before validate; narrow `agent:check` before
  package/repo scope; no broad test sweeps as diagnostics.
- Cross-agent availability: this skill is **mirrored** in `.agents/skills/sdlc` (Cursor, Codex,
  Grok, and other agents that load `.agents/skills`) and `.claude/skills/sdlc` (Claude Code).
  Keep both trees byte-identical (`pnpm run skills:mirror-check`).

## Reference routing

- **Session land / `--finish`:** `references/finish.md`
- Designer council authority: `../optimizexp/references/design-council.md`
- Stack create/update/merge + combined-diff closeout: `references/stacked-prs.md`
- Dispatch backends, handback, Done rule: `references/dispatch.md`
- Brainstorm / plan / Linear / loops / cascade: remaining files under `references/`
- Raw `gh stack` CLI for agents: companion skill `gh-stack`
- Repo git/PR hygiene: `repo` skill → `references/git-pr.md`

## Invocation examples

```text
/sdlc                         # full loop (or resume sdlc-state)
/sdlc --finish                # commit, merge main in, PR, merge-commit land all session work
/sdlc finish                  # same as --finish
```
