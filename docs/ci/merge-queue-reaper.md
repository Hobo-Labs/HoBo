---
type: CI Runbook
title: "Merge queue reaper"
description: "How runs left behind by dropped merge groups are cancelled so they stop holding hobo-trunk."
tags: [hobo, ci, merge-queue, runners]
---

# Merge queue reaper

When the merge queue removes a group (a `CI_TIMEOUT`, a failed check, a dequeue), GitHub deletes
the group's `gh-readonly-queue/...` branch but leaves the group's workflow runs in place. Their
queued jobs stay queued on `hobo-trunk`. The trunk runners take jobs oldest first, so a new group
waits behind every dropped group's jobs, passes the queue's time limit, and is dropped in turn,
leaving more queued jobs behind. On 2026-11-28, 30 of 35 active merge-group runs belonged to
dropped groups and the trunk runners were starting jobs queued five hours earlier.

| Piece | Where |
| --- | --- |
| Script (Node builtins only) | [`scripts/ci/merge-queue-reaper.mts`](../../scripts/ci/merge-queue-reaper.mts) |
| Tests | `scripts/test/merge-queue-reaper.test.ts` |
| Workflow (every merge group, every 10 minutes, and on dispatch) | [`.github/workflows/merge-queue-reaper.yml`](../../.github/workflows/merge-queue-reaper.yml) |

The job runs on `ubuntu-24.04`, so it never waits on the runners it frees. It lists the
repository's queued, waiting, pending, requested, and in-progress `merge_group` runs. For each
`gh-readonly-queue/` branch among them it checks whether the branch still exists. A run is
cancelled only when its branch is gone and its head commit is not in `main`, that is, when its
group was dropped without landing. Runs of live groups, runs of groups that landed, runs on any
other branch, and the reaper's own run are left alone. A run that finished in the meantime
answers `409` and is reported as finished.

Dispatch the workflow with `dry-run` set to `true` to print the runs it would cancel without
cancelling them. A `403` or `429` from GitHub ends the run quietly; the next run continues.
