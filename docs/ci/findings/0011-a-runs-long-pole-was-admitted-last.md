---
type: CI Performance Finding
title: "Finding 11: a run's long pole was admitted last"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 11: a run's long pole was admitted last

Main push run 41611050533 (149 s) queued four `hobo` jobs at once. They were admitted by ascending job
id: CI fabric contract guard (32 s) and Secret scan (14 s) took the two slots, then CI runner image
(40 s). Main full gate (85 s), the longest of the four, had the highest id and started 63 s after the
run was created. Two things kept #1655's order from preferring it.

- Within one run, the tiebreak after the event rank and the run's start time was the job id.
- Webhook intake reserved each job as its delivery was processed. A batch the poller ingested in one tick
  was therefore reserved in delivery order. Only jobs left pending went through the sorted
  `dispatchPending` loop.

Three changes fix this.

- `src/job-durations.ts` keeps an in-memory history keyed by repository and job name. It holds the last
  five successful durations, `completed_at − started_at`, and maps each job id to its name. Skipped and
  failed runs do not count.
- The pull-mode poller feeds every `hobo` job it reads into that history. It reads `name`, `conclusion`,
  `started_at` and `completed_at` from the `runs/{id}/jobs` lists it already fetches, so this costs no
  extra request.
- `createAdmissionOrder` now sorts by rank, then run start time, then expected duration (longest first),
  then job id. The hosted runtime sets `deferReservation`, so intake only queues a job, and the
  `dispatchPending` that ends every tick reserves the whole batch in that order.

A job with no history expects 0 and keeps the job-id order. After a daemon restart, the first poll
re-reads the completed runs in its two-hour lookback, which restores the history. Expected on the box: in
a run like 41611050533, Main full gate and the contract guard start first. Secret scan and the runner
image then follow on the freed slot while the gate runs. The run ends shortly after the gate's own finish, about 120 s
instead of 149 s. The box daemon has to be redeployed on a main that includes this change.
