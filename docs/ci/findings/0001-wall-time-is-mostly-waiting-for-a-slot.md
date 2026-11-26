---
type: CI Performance Finding
title: "Finding 1: wall time is mostly waiting for a slot"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 1: wall time is mostly waiting for a slot

Every job runs on the box worker, which holds **two** job containers at once (`HOBO_CI_WORKER_SLOTS=2` ×
`HOBO_CI_WORKER_MEMORY_MB=6144` on a 15 GiB host), and every run in the repository shares those two slots.

- **Median job wait is 189 s**; most jobs run for well under a minute.
- While at least one job was queued, the box ran **zero** jobs for 1101 s, one job for 1699 s, two for 1132 s.
  A slot sat idle with work waiting for most of that time.
- The gap between a slot freeing and the next queued job starting has a **median of 48 s** (p75 61 s,
  p90 82 s). A PR run (seven jobs on two slots) pays it about four times in series.

The idle gap has a concrete cause. Job containers run `sleep infinity` as PID 1, and PID 1 ignores
`SIGTERM`, so each `docker stop -t 30` that ends a finished lease waits the full 30 s for `SIGKILL`. The poll
tick reconciles leases serially, so that stop also delays launching the next job. Runner registration and
boot account for the rest.

Fixes: [#1641](https://github.com/Hobo-Labs/HoBo/pull/1641) (`docker create --init`). Needs a box redeploy;
the restart on `96b9b70e` predates it.

Since the restart the box runs two slots in parallel, and queueing for them is the largest share of wall
time. Between 21:02 and 21:35 UTC six runs (#1638's merge group and five PR runs) were queued at once, about
forty jobs for two slots. #1642's PR impact gate waited 17 minutes for a slot and then ran in 41 s; its
off-path job ran in 100 s. Fewer jobs per run is now worth more than faster jobs.

**The wait does not count against `timeout-minutes`.** GitHub starts a job's timeout when a runner picks it
up. Over 98 jobs the gap between `started_at` and the first step was at most 4 s, and in the last 40 runs no
`artifact signing and install verification` job timed out: the longest waited 18 minutes before `started_at`
(run 41523529717) and then passed in 39 s. A job that ends at its timeout was alive on a runner for that
long, which is finding 6, not a slot wait.
