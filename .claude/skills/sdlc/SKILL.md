---
name: sdlc
description: Implement and validate repository changes, using incremental commits and stacked pull requests when appropriate, and land each workstream through one pull request with a merge commit (never squash or rebase-merge). Supports --finish to land the current session.
---

# SDLC coordinator

Follow the repository rules in `AGENTS.md` for every task and harness.

1. Inspect the request, relevant code, and existing tests. Complete unfinished work found in scope.
2. Implement the change directly with self-documenting names, types, and functions. Do not create plans, design documents, or session state files.
3. Run only tests related to your changes (file-scoped, package-scoped, `pnpm run test:changed`, `pnpm run test:affected`, or `pnpm run agent:check -- --staged`), never unfiltered full-repo suites unless explicitly requested (`HOBO_ALLOW_BROAD_TESTS=1`). Fix failures before continuing.
4. Use incremental commits. For dependent changes, use the repository's `gh-stack` skill to create and update a stack of reviewable pull requests.
5. Report the implemented behavior, validation, and concrete blockers. Do not merge or deploy unless the user authorized it.

## Landing

- A workstream has at most one open pull request. Review and validate locally while it is draft, then mark it ready to run GitHub Actions. If a gate fails, return it to draft and fix the same branch. A stack lands as one unit through the pull request for its top layer, based on `main`; do not open a pull request per layer.
- Update a pushed branch by merging `origin/main` in (`git merge origin/main`). Never rebase a pushed branch and never force-push; `gh stack rebase` and `gh stack sync` are only for unpushed local layers.
- Never squash and never rebase-merge. Land with a merge commit (`gh pr merge <n> --merge`, or the merge queue with the merge-commit method); lower layers then show as merged because their commits are in `main`.
- Before opening a pull request and before landing, check for supersession. Ancestry alone does not prove the carrier kept the work: compare the PR's changed paths and modes with the proposed carrier, and recheck both heads before closing. Keep distinct stack layers open for bottom-up review and merging, and keep any pull request open if the original changes cannot be established or the carrier differs.

```bash
git merge-base --is-ancestor <head> origin/main && echo 'ancestor of main; verify changes'
git merge-base --is-ancestor <head> <other-open-pr-head> && echo 'ancestor of another head; verify changes'
```

- List the session's workstreams before starting: one branch and one pull request each. The pre-tool hook refuses a fourth unlanded pull request from one session's branches.
- Merge groups run on `merge_group` from a detached checkout with no `GITHUB_HEAD_REF`; PR CI runs its test shards the same way, so tests must not read the branch name. The queue's merge method is the owner's ruleset setting; local signoff accepts only a squash group commit on the current base. Never change the ruleset.
- A group that passes the queue's time limit (`CI_TIMEOUT`) drops the pull request and is not rerun; re-queue it once the cause is fixed.
- Automatic supersession runs report candidates without closing them. After reviewing the work and feedback, an explicitly non-dry-run manual dispatch considers exact-head duplicates or work demonstrably retained on `main`, checks that changed paths still match the carrier, and rechecks the snapshots. Distinct stack layers and empty or uncertain comparisons stay open.
- Merges resolve the `scripts/ci/attestation.mts` pins and `docs/ci/errors.md` through the drivers `scripts/ensure-hooks-path.sh` registers. When a driver leaves one conflicted, resolve the rest, then run `node --experimental-strip-types --no-warnings scripts/ci/merge-driver.mts refresh`.
- Merged pull requests do not finish a task; check the delivery goal in `PRODUCT.md` and its evidence.

## `--finish`

`/sdlc --finish` authorizes landing the current session: commit remaining work, fetch and merge the latest `origin/main` in, resolve conflicts keeping both sides' work, run the supersession check, open or update the one workstream pull request, push, review its combined diff against `main`, resolve every actionable review thread, repair real check failures, and land it with a merge commit. All applicable ready-state required checks and release jobs must actually pass; never bypass them for billing, quota, runner, or other failures.
