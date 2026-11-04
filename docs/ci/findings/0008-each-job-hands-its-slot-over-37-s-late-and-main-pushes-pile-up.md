---
type: CI Performance Finding
title: "Finding 8: each job hands its slot over 37 s late, and main pushes pile up"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 8: each job hands its slot over 37 s late, and main pushes pile up

Sample: every `hobo` job of the 31 HoBo CI Fabric runs created 2026-11-02 22:00 to 2026-11-03 01:56 UTC
(13 `merge_group`, 11 `pull_request`, 7 `push`), from the GitHub jobs API. Merge-queue entries waited
27–40 minutes, while the jobs they needed run 8–40 s.

**Where the slot-minutes went.** Main full gate on `merge_group` used 60.8 of about 150 job-minutes: nine
runs, every one failing or cancelled, gating nothing, because it is not a required check. Secret scan and
CI runner image waited 25–29 minutes on average in merge groups, for 8–12 s of work each. #1645 and #1647
take those three jobs off `merge_group`, leaving the CI fabric contract guard as each group's only `hobo`
job.

**Handoff, not slot count.** After the SQLite daemon came up (00:30 onward), the gap from one job's
`completed_at` to the next job's `started_at` was 31–45 s (median about 37 s) whenever work was queued.
For long stretches the box ran one short job at a time while 20 or more were queued. For example, between
01:11 and 01:18 no Main full gate was running, yet jobs started at 01:12:25, 01:13:42, 01:14:10 and
01:14:31, each a few seconds long. Since 00:30, a slot was empty while jobs were queued for about 40
slot-minutes. Two causes, both in the box daemon:

- `docker stop -t 30` on a job container whose PID 1 was `sleep infinity`. Without an init process, PID 1
  ignores SIGTERM, so every reap waited the full 30 s, and the lease counted as a live slot throughout.
  [#1641](https://github.com/Hobo-Labs/HoBo/pull/1641) (`--init`) fixes this once the daemon restarts on it.
- The daemon learned that a job was done only from GitHub. The poller (every `HOBO_CI_JOB_POLL_MS`, 15 s)
  had to report the runner's job first, then a tick's `getJob` had to see it completed. The JIT runner
  exits after its one job, so `startRunner` now writes `/tmp/hobo-ci-runner-exited` when `run.sh` returns,
  and reconcile reaps the container on the next 2 s tick when the marker is there. A runner that dies
  before taking a job is reaped the same way, and its reserved job is requeued. Before this it held the
  slot until the lease's maximum runtime.

**Main pushes.** The concurrency group never cancelled an in-progress push to main. Each squash merge
started a run whose Main full gate held a slot for about 7 minutes. Once two pushes landed close together,
both slots held a Main full gate and the queue's short jobs waited behind them. Two changes:

- The workflow group now includes the event name and cancels an in-progress push run. The newest push
  scans the full history and tests the newer tree.
- Main full gate also sits in a job-level group, so at most one runs at a time, whatever started it. The
  second slot stays free for short required jobs.

Schedule and `workflow_dispatch` runs are in their own groups and are never cancelled by a push.

**Expected.** One `hobo` job per merge group (about 40 s of run) plus a handoff of a few seconds, instead
of about 37 s. Five groups on the one slot Main full gate leaves free come to about 4 minutes. The box
daemon has to be restarted on a main that includes #1641 and this change before either handoff fix
applies.
