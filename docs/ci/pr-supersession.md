---
type: CI Runbook
title: "PR supersession: one open PR per landed change"
description: "What the PR supersession job closes, when it runs, how it paces itself against GitHub's secondary rate limit, and how to dry-run it."
tags: [hobo, ci, pull-requests, merge-queue, stacks]
---

# PR supersession: one open PR per landed change

A stack lands as one unit through its top pull request with a merge commit (see the `sdlc` and
`gh-stack` skills). Every lower layer's commits are then in that top PR's history, so a separate
open PR for a lower layer only adds review and queue work and conflicts. The supersession job closes
those PRs.

| Piece | Where |
| --- | --- |
| Script (node builtins and git only) | [`scripts/ci/pr-supersession.mts`](../../scripts/ci/pr-supersession.mts) |
| Tests | `scripts/test/pr-supersession.test.ts` |
| Workflow (every push to `main`, hourly, and on dispatch) | [`.github/workflows/pr-supersession.yml`](../../.github/workflows/pr-supersession.yml) |
| Lint allowance: one GitHub-hosted job, `supersession`, that runs the script | `scripts/lint-actions.ts` |

## What it closes

An open, same-repository pull request against `main` is closed when its head commit is

- already in `main`, or
- an ancestor of another open pull request's head. The carrier named in the comment is a PR that no
  other open PR carries, the oldest when several qualify. Of two PRs at the same head, the older stays.

Each closed PR gets a comment naming its carrier. Branches are never deleted, and
`refs/pull/<n>/head` keeps every commit reachable.

## Pacing

Comments and closes are spaced three seconds apart. On a `403` or `429` the job stops and reports
how many it closed. It also stops after 15 minutes of closing so the job stays inside its 20-minute limit. Either way the next hourly run continues from the current set of open PRs.

## Dry run

Dispatch the workflow with `dry-run` (the default for a dispatch) to print each decision without
writing anything.
