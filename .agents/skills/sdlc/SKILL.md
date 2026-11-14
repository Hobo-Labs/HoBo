---
name: sdlc
description: Coordinate iterative feature/capability development end to end in this repo — brainstorm with adversarial and rubber-duck hardening, plan through the draft-proof cascade, capture one-shot issues, dispatch subagents with incremental checkins, manage multi-phase work as GitHub stacked PRs (gh stack), then bottom-up rubber-duck/adversarial review, comment resolution, status-check repair, and squash-merge of every opened PR. Supports --finish to land the current session (commit, rebase on latest main, resolve conflicts, open/update PRs, push, bottom-up closeout, squash-merge all session PRs). Use when the user wants to develop a feature through the full loop, says "sdlc", "run the loop", "stacked PRs", "take this from idea to merge", "sdlc --finish", or "finish the session".
---

# SDLC coordinator

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
| **`--finish`** / `finish` | **Land the current working session** — no new product brainstorm unless required to ship. Commit remaining work, fetch/rebase on latest trunk, resolve conflicts, open/update PRs, push, bottom-up review, **squash-merge every PR from this session**. Full protocol: `references/finish.md` |

`--finish` is **explicit authorization** to push, open/update PRs, and squash-merge session work
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

## Durable state (read this FIRST, every session)

State lives in `.sdlc/<initiative-slug>/sdlc-state.md` (phase, decisions, dispatched issues →
worktree/branch/PR/**stack layer**). On entry: read it; if it exists, **reconcile before anything
else** (see `references/dispatch.md` § Resume). Write it at every phase boundary. Dispatch outcomes
append to `.sdlc/dispatch-log.md`. Record stack id / branch chain / PR numbers in the state file.

`.sdlc/` is ignored by git. This state is working material and is never committed (AGENTS.md,
"Plans are not committed"); the issue tracker and the pull requests are the record that outlives
a machine.

For design-relevant layers, also record `designerConsensus.required`, `reviewId`,
`cycle`, `result`, `consensusEntryId`, `proposalDigest`, `reviewedHeadSha`, and
`assertedAt`. This Markdown is a coordinator view, not approval authority; the
OptimizeXP council state and append-only bus must pass deterministic
`consensus-loop.mts --mode assert-yay` on the current head.

```yaml
designerConsensus:
  required: true
  reviewId: <id>
  cycle: <n>
  result: yay
  consensusEntryId: <id>
  proposalDigest: <sha256>
  reviewedHeadSha: <sha>
  assertedAt: <timestamp>
```

## Phases (details in references/)

0. **`--finish` (session land)** — `references/finish.md`. When the flag is present, run the
   finish protocol instead of starting a new initiative: commit → latest trunk → conflicts →
   PR(s) → bottom-up closeout → squash-merge **all session PRs**. Then stop (or only open a
   tiny state/docs follow-up if still needed).
1. **Brainstorm & harden** — `references/brainstorm.md`. Always start here for new
   features/capabilities. Ideas must survive adversarial + rubber-duck passes before planning.
2. **Plan** — `references/planning.md`. Enter plan mode; map the work onto the draft cascade
   (technical proofs → epic proofs; experience proofs in parallel; project proofs aggregate);
   every proof change follows plan → improve → ADR-beside-the-proof; new tech/screens/features go
   through the **draft** skill. **Slice multi-phase work into stack layers** (dependency order:
   foundations at the bottom, dependents above).
3. **Issue capture** — `references/linear-planning.md`. Initiative/projects/milestones/issues,
   each issue a self-contained one-shot contract with verifiable outputs and required draft
   artifacts named explicitly. Prefer **one issue per stack layer**.
4. **Dispatch + stack** — `references/dispatch.md` + `references/stacked-prs.md`. ONLY after
   explicit user permission for offloading. Detect harness backends; claim issues; spawn
   subagents with incremental-checkin rules; parent owns `gh stack init|add|submit|sync`.
5. **Loops & cascade** — `references/loops-and-gates.md` + `references/cascade.md`. Red/green
   inner loop, narrow-then-wide outer loop, and machine-checked upward/downward requirement
   cascades.
6. **Close the stack (mandatory)** — `references/stacked-prs.md` § Bottom-up closeout (same
   merge steps as `--finish`, scoped to the initiative stack). When implementation is done, the
   **parent** reviews and merges **each PR from the bottom up**. Do not mark the initiative
   complete until every opened PR is reviewed, repaired (when repairable), and **squash-merged**.
   Billing/budget-only CI failures do **not** block merge.
   Every design-relevant layer additionally requires the exact-six designer
   council after evidence refresh and another current-head `assert-yay`
   immediately before merge. Any nay returns to implementation; any later
   commit or effective-diff change makes the approval stale.

## Role split

| Actor | Owns | Does not own |
|---|---|---|
| **Parent (this skill)** | User dialogue, plan, Linear, shared files, **stack topology**, PR submit/sync, bottom-up review, comments, CI repair, squash-merge | Implementing every layer itself when a subagent is available |
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
5. Multiple commits per layer are expected and good. Do **not** squash locally before handback
   unless the issue contract says otherwise — squash happens at **merge** time.

The parent may also require the subagent to open or update its layer branch via the branch the
parent created in the stack; the parent alone runs `gh stack submit|sync|merge`.

## Stacked PRs for multi-step work (parent)

For any work with 2+ dependent phases/tasks:

```bash
# Non-interactive only — never hang on prompts/TUIs
gh stack init sdlc/<initiative>-01-<slug>
# ... subagent works + incremental commits on that branch ...
gh stack add sdlc/<initiative>-02-<slug>
# ... next layer ...
gh stack submit --auto --open     # create/update linked PRs
gh stack view --json              # always --json for agents
gh stack sync                     # after trunk moves or lower-layer changes
```

Hard agent rules for `gh stack` (summary — full set in `references/stacked-prs.md` + `gh-stack` skill):

- Always pass branch names to `init` / `add` / `checkout` (no bare interactive forms).
- Always `gh stack submit --auto` (add `--open` when ready for review).
- Always `gh stack view --json` (never interactive TUI).
- Mid-stack fixes: navigate to the correct lower branch, commit there, `gh stack rebase --upstack`, push.
- **Merge stacked PRs with `gh stack merge`**, not bare `gh pr merge`, when merging a stack range.
  Prefer **`--squash`**. For sequential bottom-up closeout, merge one PR at a time (see closeout).

Single-layer / single-issue work may use a normal PR; multi-step work **must** stack.

## Bottom-up closeout (required for every PR the parent opened)

When the parent is done dispatching implementation, it **must** process the stack from the
**bottom (closest to trunk) to the top**:

For **each** open PR in bottom-up order:

1. **Rubber-duck the diff** — explain the layer step-by-step as if to a new contributor: problem,
   approach, files, tests, risks, rollback. Anything you cannot justify plainly is a defect.
2. **Adversarial pass** — red-team the layer: failure modes, security/tenancy, broken contracts,
   cascade/reg misses, over-engineering, missing gates, silent shared-file edits by subagents.
3. **Independent review** — spawn the `reviewer` (or re-run the acceptance checklist yourself on
   a clean checkout). Do not trust the implementer's self-report.
4. **Designer council when relevant** — deterministically classify the changed
   paths and acceptance tags, refresh evidence, and run or resume the exact-six
   OptimizeXP council. A nay emits rework; repeat implementation → independent
   review → evidence → council until unanimous current-head yay or honest
   blocked termination. A non-design exemption must be machine-readable and
   justified; never skip silently.
5. **Comments & review feedback** — list every unresolved PR comment and review thread
   (`gh api` / `gh pr view` / review comments). Address **all** of them: fix code, or reply with
   a reasoned non-action and resolve the thread. Leave no actionable thread open.
6. **Status checks** — wait for required checks when they can run. Repair real failures
   (tests, lint, architecture). Re-run narrow gates after fixes; `gh stack sync` / rebase so CI
   sees the fix.
   - **Billing / budget / quota does not block squash-merge.** If a check fails solely because
     jobs never started or aborted for spending limit, payment failure, exhausted CI minutes,
     runner quota, or similar **non-code** billing signals (empty steps, no runner assigned,
     annotation like "spending limit" / "payments have failed"):
     1. Record the exception on the PR comment + `sdlc-state.md` (which checks, exact message).
     2. **Squash-merge immediately** — do **not** wait for green CI, do **not** stall for user
        approval of the merge itself (user already authorized the workstream; tell them billing
        is broken so they can fix account settings later).
     3. Use `gh pr merge <n> --squash` (or `gh stack merge <n> --yes --squash`). If branch
        protection still requires green checks, retry with `--admin` when the token has that
        permission. If merge is impossible without elevated rights, say so — still do not
        leave the PR as "waiting on CI" when CI cannot run.
     4. Never use this exception for real test/lint/type failures.
7. **Re-assert designer consensus** for relevant work after all comment/check
   fixes. If HEAD, effective diff, acceptance, or evidence changed, refresh and
   reconvene; do not merge stale approval. Billing exceptions do not waive this.
8. **Squash-merge that PR** when review is clean and either checks are green **or** only
   billing-budget failures remain (after documenting them):
   ```bash
   # Stack-aware (preferred when in a stack):
   gh stack merge <pr-number> --yes --squash
   # Single PR / non-stack:
   gh pr merge <pr-number> --squash --delete-branch
   # If protection blocks on billing-red checks and you have admin:
   gh pr merge <pr-number> --squash --delete-branch --admin
   gh stack sync --prune   # after merge; realign remaining layers
   ```
9. Only then move to the next PR up the stack. Repeat until the stack is fully merged.

Do **not** batch-merge the whole stack until every lower layer has passed rubber-duck + adversarial
review and comment/check cleanup. Prefer one-PR-at-a-time bottom-up merges so each layer's review
is honest against its final base.

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
  comments/threads are addressed, and (d) the PR is **squash-merged**. Billing-red CI is not a
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
- Stack create/sync/merge + bottom-up closeout: `references/stacked-prs.md`
- Dispatch backends, handback, Done rule: `references/dispatch.md`
- Brainstorm / plan / Linear / loops / cascade: remaining files under `references/`
- Raw `gh stack` CLI for agents: companion skill `gh-stack`
- Repo git/PR hygiene: `repo` skill → `references/git-pr.md`

## Invocation examples

```text
/sdlc                         # full loop (or resume sdlc-state)
/sdlc --finish                # commit, rebase, PR, squash-merge all session work
/sdlc finish                  # same as --finish
```
