---
type: CI Performance Finding
title: "Finding 89: pr diff base stale event sha"
description: "PR jobs diffed against the event's base SHA, so main's later changes read as the PR's: unrelated PRs built multi-GB deps images and filled the fleet's Docker disk."
tags: [hobo, ci, fleet, docker, disk, pull-request]
---

# Finding 89: pr diff base stale event sha

## Evidence

PR #1852 changed only `packages/ci-agent` and `packages/hobo`, none of the deps image inputs. Its **CI deps layer (pnpm)** job still built the deps image twice:

- On `26d9b44d` the build reached `final 53/68`, a `COPY` of a node_modules bucket into `/opt/hobo-deps/`, and failed with `no space left on device` on the fleet runner's Docker storage.
- On `a68c4ce5` it first had to build the toolchain image, and failed downloading Chromium headless shell (`curl: (35) Recv failure: Connection reset by peer`).

GitHub reported the PR's `base.sha` as `c60d341d` while `main`, which its merge commit was built on, was at `eec5c169`.

## Cause

Both PR-scoped steps diffed against `github.event.pull_request.base.sha`:

- **Limit PR builds to deps image inputs** (`ci-deps-image`): `git diff "$base" HEAD`.
- **Resolve Turbo SCM base** (`pr_gate_validation`): `git merge-base "$PR_BASE_SHA" HEAD`.

A PR job checks out `refs/pull/N/merge`, a merge commit whose first parent is the base branch as it is **now**. The event's base SHA can be older. Between the two, main merged #1850, which changed `scripts/lib/deps-key.mts`, a deps image input, and files in `packages/ci-gh-actions`, `ci-vercel`, `hobo` and `trails`, which the Turbo base counted as the PR's affected packages. Diffed from the older SHA, that change read as the PR's own, so every open PR rebuilt a several-GB deps image on the shared fleet until main's publisher caught up. The concurrent builds are what ran the Docker disk out. The build script's headroom guard (8 GB, 400k inodes) is checked once before a build and cannot account for other builds running at the same time.

## Fix

On GitHub's PR merge commit, both steps take its first parent (`HEAD^1`) as the base: exactly what the PR was merged into, so the diff is the PR's own change. The merge commit is recognised by its second parent being the PR head (`pull_request.head.sha`), so any other merge at HEAD, such as a PR head that merged main in, keeps the earlier behaviour. The deps job now fetches two deep so the parents exist. The event SHA, still validated, is used whenever HEAD is not that merge commit.

`scripts/test/pr-diff-base.test.ts` runs both steps' shell against a real repository with the stale-base shape. A PR that leaves the deps inputs alone does not build, one that changes them does, the affected set starts at the first parent, and a merge whose second parent is not the PR head falls back to the event's base. The first three fail against the previous workflow.
