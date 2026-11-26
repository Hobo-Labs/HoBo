# Stale PR cleanup

## Loop

Recurring maintenance on the HoBo GitHub repo: open PRs that sat >24h without merge, or draft PRs with green CI waiting on human action.

## Related specs

- [`docs/automations/hobo-issue-worker.md`](../docs/automations/hobo-issue-worker.md) — issue implementation worker (creates PRs; does not merge)
- [`.claude/skills/loop-me/SKILL.md`](../.claude/skills/loop-me/SKILL.md) — workflow spec authoring discipline

## Trigger

**Event** — scheduled daily scan **or** manual `/stale-pr-cleanup` invocation.

Scan criteria:
- `gh pr list --state open` where `now - createdAt > 24h`
- include draft PRs with `mergeable: MERGEABLE` and CI `SUCCESS` regardless of age

## Steps

### 1. Triage (autonomous)

For each open PR, classify:

| Class | Signals | Action |
|---|---|---|
| **Ready** | mergeable, CI green, work complete | merge `origin/main` in, validate, mark ready, merge (merge commit) |
| **Superseded** | head is an ancestor of another open PR's head or already in `origin/main` (`git merge-base --is-ancestor <head> <other-head>`), or same intent already on `main` (e.g. duplicate pnpm migration) | close `Superseded by #N`, keep branch |
| **Needs work** | mergeable but failing checks or incomplete acceptance | own branch, fix, validate, merge |
| **Blocked** | conflicts + unique unmerged work | merge `origin/main` in, resolve conflicts, validate, merge |

Priority: **Ready** and **Superseded** first (fast wins).

### 2. Claim (autonomous, parallel-safe)

Many review-and-merge workers may run concurrently. Before touching a PR:

1. Generate a unique `RUN_ID` (e.g. UUID) for this run.
2. Post a PR review comment: `🤖 CLAIM run=<RUN_ID> ts=<iso8601-now>`.
3. Re-read PR comments; among all `🤖 CLAIM run=…` comments, earliest timestamp wins.
4. If another run won, post `🤖 YIELD run=<RUN_ID> (lost to <winner>)` and pick the next PR.
5. Verify PR is still open and mergeable before proceeding.

### 3. Own (autonomous)

Pick highest-priority claimed PR. Checkout head branch, `git merge origin/main` (never rebase a pushed branch).

### 4. Review & optimize (autonomous)

- Read changed scope only
- Run `pnpm agent:check -- --base=origin/main`
- Apply minimal fixes; no scope creep
- Keep the branch's commits as-is; never squash or rewrite pushed history

### 5. Push & wait for CI (autonomous)

```bash
git push -u origin <branch>
```

Poll until `docs` and `PR impact gate` are `SUCCESS`.

### 6. Merge or zero-out (autonomous)

**Ready / Needs work / Blocked (resolved):**
```bash
gh pr ready <n>
gh pr merge <n> --merge --subject "<conventional commit>" --body "Closes HOBO-N"
```

Never `--squash`, never `--rebase`. A merge commit puts the PR's own commits on `main`, so PRs
whose heads it contains are marked merged automatically.

**Superseded:**
```bash
gh pr close <n> --comment "Superseded by #N"
```
Keep the branch. If `gh pr close` is not permitted, post the `Superseded by #N` comment and
report the PR for a human to close; never force-push the head branch.

### 7. Update Linear (autonomous)

For each merged PR linked to `HOBO-N`:
- Confirm issue status is **Done** (set if still open and acceptance met)
- `save_comment` with PR URL, merge SHA, proof paths, test count

### 8. Repeat until all scanned stale PRs are triaged

Re-scan `gh pr list --state open` and continue while any PR still matches stale criteria (age >24h or draft-with-green-CI). New PRs opened after the scan are out of scope until the next trigger.

## Checkpoint

**None** for Ready/Superseded/Blocked-with-clear-resolution.

**Brief required** when:
- PR has unique unmerged work AND conflicts cannot be auto-resolved without dropping commits
- CI fails after two fix attempts
- merge would delete or regress `main` content

### Brief format

```
## Stale PR cleanup — decision needed

**PR:** #N — <title>
**Class:** Blocked
**Conflict:** <files or areas>
**Options:**
1. Take main (drop PR commits) — recommended if superseded
2. Take PR (keep branch work) — recommended if main is missing it
3. Manual merge — both sides have unique commits

**Agent recommendation:** <option> because <reason>
**Link:** <PR URL>
```

Push brief as PR comment if permitted; otherwise stop and report.

## Push right

Defer human involvement until step 6 fails or step 8 completes for all scanned stale PRs. Agent runs full validate + merge before any checkpoint.

## Definition of done

- Every PR matching stale scan criteria is classified and acted on (merged, zeroed-out, or checkpoint brief posted)
- Every merged PR has Linear comment with SHA + proof paths (when linked to `HOBO-N`)
- No failing `agent:check` on merged work
- Superseded PRs closed with `Superseded by #N` (branches kept)
- Merge comments include `run=<RUN_ID>` for audit trail

## Out of scope

- Creating new feature work unrelated to open PRs
- Chasing pre-existing `main` test/doc failures unrelated to PR diff
- Force-merging with red CI
- Closing PRs that have unique unmerged commits without triage
