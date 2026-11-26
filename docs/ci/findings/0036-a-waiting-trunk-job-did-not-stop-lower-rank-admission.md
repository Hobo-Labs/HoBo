---
type: CI Performance Finding
title: "Finding 36: a waiting trunk job did not stop lower-rank admission"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 36: a waiting trunk job did not stop lower-rank admission

On 2026-11-04, #1709's merge-group **PR impact gate** queued at **14:10:50Z** and started at **14:16:03Z**, a **5 m 13 s** admission delay. Read-only GitHub API queries reconstructed these timestamps (all UTC):

| Run / job | Runner | Created or queued | Started | Completed |
|---|---|---|---|---|
| #1709 PR run **41840794280**, **PR impact gate** job **126619584695** | `hobo-37829e08-3ed9-4bc1-8e3b-fac18009ee33` | 13:59:12 | 14:01:03 | 14:08:22 |
| #1709 merge-group run **41844979849**, **PR impact gate** job **126626018847** | `hobo-c4bc7af4-6106-487c-9a59-692b4efc89d4` | 14:10:50 | 14:16:03 | 14:34:23 |

The initial `actions/runs?created=2026-11-04T13:40..2026-11-04T14:20` query returned five runs. Reading each run's jobs, then widening the query to the newest 100 runs from the day's 00:00–14:20 window (reaching back to 06:58), found **no non-skipped HoBo PR job overlapping 14:10:50–14:16:03**. In particular, #1709's last PR gate ended **2 m 28 s before** its merge-group job queued. Thus the API confirms the delay but does **not** substantiate the initial supposition that PR jobs kept running throughout it; daemon lease and container logs are required to identify what local capacity remained occupied. Skipped jobs have timestamps but no runner and do not indicate occupancy.

The admission defect was real independently of that occupancy question. Memory admission returned `blockRank` only after `HOBO_CI_WORKER_MEMORY_HOL_MS`, and the relay applied it only to the same rank within one pass. A rank-0 memory waiter therefore allowed lower-rank backfill before the timeout and did not block rank 1 afterward. Merge-group cap and slot-reservation waits had no lower-rank barrier either.

Admission is now trunk-first while any feasible rank-0 job waits. A rank-0 memory wait blocks lower ranks immediately; merge-group cap and failed slot reservation do the same. The barrier is recomputed from pending demand every pass, so it persists until the rank-0 job is admitted, at which point lower ranks can use remaining capacity in that pass. Non-zero ranks retain the 60 s same-rank HOL backfill window, and trunk-label lending, strict slot reservation, and unlaunched-lease reclamation are unchanged. As an anti-starvation guard, a request larger than the entire memory budget never raises the rank-0 barrier: it cannot fit even on an idle host, so PR admission remains allowed. Regression coverage drives the real SQLite/relay path for memory, merge-group cap, and slot waits across repeated passes, plus the impossible-memory-request guard.
