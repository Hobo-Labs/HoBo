---
type: CI Performance Finding
title: "Finding 172: evicted merge groups held the trunk runners"
description: "Merge-group runs of HoBo CI Fabric took 60 to 100+ minutes on 2026-11-28 because 107 of 109 unfinished self-hosted jobs belonged to groups the queue had already dropped. Their queue refs were unique, so cancel-in-progress never reached them. Every merge-group job now checks that its queue ref still exists at its SHA before it checks out or installs, and a dropped group's jobs stop in seconds."
tags: [hobo, ci, runners, merge-queue, trunk, concurrency]
---

# Finding 172: evicted merge groups held the trunk runners

## Measurements

On 2026-11-28, `main` stayed at `3474ceb3c` from 05:06 UTC. Merge-group runs
46150929937 and 46146144632 were cancelled after 63 and 100 minutes without
starting a job; run 46158070891 was still waiting on its first job, and run
46118253422 took 86 minutes.

Per job, from `actions/runs/<id>/jobs`, queue wait is `started_at - created_at`
and execution is `completed_at - started_at`:

| Run | Job | Label | Queued | Ran |
| --- | --- | --- | --- | --- |
| 46118253422 | Route runners | `hobo-trunk` | 5.6 min | 0.3 min |
| 46118253422 | PR impact plan | `hobo-trunk` | 14.7 min | 0.5 min |
| 46118253422 | Scripts tests (0) | `agent37` | 16.5 min | 4.8 min |
| 46118253422 | Workspace test shard 5 | `hobo-trunk` | 22.2 min | 4.0 min |
| 46118253422 | PR impact gate | `hobo-trunk` | 28.9 min | 0.3 min |
| 46136928391 | PR impact plan | `hobo-trunk` | 51.4 min | 3.8 min |
| 46131165541 | PR impact plan | `hobo-trunk` | 64.8 min | 4.7 min |

Runs 46136928391 and 46131165541 reused the pull-request run's proof: all
their jobs together ran for under 7 minutes, and they waited 74 and 72
minutes. The time went to queue wait, not execution.

At 15:10 UTC, 36 `merge_group` runs were queued and one was in progress.
28 were HoBo CI Fabric runs, but only two `gh-readonly-queue/main/*` refs
existed. Of 109 unfinished jobs in those runs (107 queued, 2 running), 107
belonged to groups the queue had dropped: 75 on `hobo-trunk` and 32 on
`agent37`. The median queued job had waited 102 minutes and the oldest 350.
The two running jobs were workspace shards of dropped groups: one was
created at 09:38 and started at 15:08.

## Cause

The workflow's concurrency group for `merge_group` is
`HoBo CI Fabric-merge-group-<head_ref>`, and `head_ref` is
`gh-readonly-queue/main/pr-<number>-<base sha>`. When a group fails or passes
the queue's check timeout (about 60 minutes: #2598 entered at 14:28:48 and
was removed at 15:27:17 while its run 46158070891 was still queued), every group built on it is rebuilt on a
new base, with a new ref, so no newer run shares its key. `cancel-in-progress`
only cancels the older run when the same PR is queued again on the same base.
A run of any other dropped group keeps every job queued, and runners
started jobs that had been queued for hours. A new group therefore waited behind hours of dead
work, timed out, and left its own run behind.

## Fix

- `.github/actions/ci-runner-preflight/merge-group-live.mts` reads the run's
  queue ref with `GET /repos/{repo}/git/ref/{ref}` using the job token. A ref
  at the run's SHA continues. A missing ref whose SHA is not on the base
  branch (`compare` reports `ahead` or `diverged`), or a ref now at another
  SHA, exits with code 3. A group that landed (`identical` or `behind`)
  continues, so its run can still finish green for merge-queue reuse on the
  `main` push.
- `merge-group-live.sh` turns code 3 into a failed step. Any other outcome
  (an API error, a timeout, a Node too old for type stripping) prints a
  warning and lets the job run, so a lookup failure never fails a live group.
- Route runners runs the check right after its sparse checkout, so a run
  whose group was dropped while it waited never starts a downstream job.
- `hobo-repo-checkout` runs it before the full checkout and
  `ci-runner-preflight` before toolchain and browser setup, so every routed
  merge-group job in HoBo CI Fabric, and the release workflow's Pages build,
  stops in seconds when its group is gone.

## Expected effect

A job of a dropped group holds a runner for the length of a sparse checkout
and one or two API calls, not for 5 to 20 minutes of install and tests. A
backlog of dropped groups clears at the rate runners can start jobs, and the
runners then serve the live groups. Runs created before this change still run
their old workflow.

## Remaining limits

- A dropped group's job still has to be assigned a runner before it can stop.
  Cancelling those runs from outside, without waiting for a runner, is a
  separate change.
- Workspace shards that land on ARC `hobo-trunk-runner-*` pods ran for more
  than 20 minutes in run 46118253422, while the same shards on Agent37 boxes
  finished in 2 to 4 minutes.
