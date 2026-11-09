---
type: CI Performance Finding
title: "Finding 10: the job poller spent the installation's rate limit on finished runs"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 10: the job poller spent the installation's rate limit on finished runs

The worker reached the poller's floor (fewer than 300 calls left) and paused polling, so queued jobs
waited for the reset. Each poll (every 15 s) made three run-list reads plus one jobs read per run, and the
completed-runs list covers every workflow's runs from the last two hours, up to 50. With 50 completed runs
that is about 53 counted reads a poll, or about 12,700 an hour against a 5,000-an-hour installation
budget, almost all of it re-reading jobs that can no longer change. The lookback URL also embedded the
current time, so no two polls asked the same question.

`packages/ci-gh-actions/src/isolated-worker/github-job-poller.ts` now:

- sends `If-None-Match` with the last ETag on every read and reuses the cached body on a 304, which does
  not count against the limit;
- rounds the `created>=` lookback down to 10 minutes, so the completed-runs URL is the same between polls;
- stops reading a completed run attempt once every job in it was seen completed and ingested, and drops it
  from memory once it leaves the lookback. A re-run is a new attempt and is read again.

An idle poll now costs nothing, and a busy one costs one read per run whose jobs changed. The box daemon has
to be redeployed on a main that includes this change.

The status filter itself turned out to be unreliable. For run 41622562414, `?status=queued` answered
`total_count: 0` for more than 16 minutes while the unfiltered `/actions/runs?per_page=3` listed the run as
queued, and nothing in the logs said so: a non-OK read came back as an empty list, and the daemon logged a
poll only when it accepted a job or paused. The poller now also reads the newest 50 runs with no status filter
(same ETag rule, so it costs nothing while the list holds still and one read a poll while runs move) and
unions them with the filtered lists: a run not `completed` there has its jobs read, and a `completed` one joins
the completed-runs lookback. Every read GitHub refuses is logged as `hobo_ci_isolated_worker_github_read_failed`
with its path and status. Each poll summary also carries the queued `hobo` jobs it saw but did not newly
accept (`waiting`, as `run/job:result`, where the result is `duplicate`, `ignored` or `failed`). The daemon
logs a poll that accepted a job, refused one, failed a read or paused. It also logs one whose waiting jobs
changed, and repeats that line once a minute while the same jobs keep waiting.
