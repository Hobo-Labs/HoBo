---
type: CI Performance Finding
title: "Finding 27: a completed merge-group lease still occupied the trunk slot"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 27: a completed merge-group lease still occupied the trunk slot

On 2026-11-04 the three-slot box ran one reserved trunk slot and two general slots (`generalLeaseLimit = 2`, strict `HOBO_CI_WORKER_TRUNK_LEND=0`). GitHub job timestamps showed this sequence (UTC):

| Time | Runner / demand | What happened |
|---|---|---|
| 06:16:47–06:17:50 | `hobo-d0156479`, `hobo-trunk` | merge-group **PR impact gate** ran |
| 06:17:55–06:18:31 | `hobo-6bf2a922`, `hobo` | PR job ran |
| 06:17:57–06:18:25 | `hobo-83ed240a`, `hobo` | PR job ran |
| 06:18:26 | two `hobo-trunk` jobs queued | **@hobo/pricing affected gate** and **Main full gate** queued on a main push |
| 06:18:31–06:21:34 | `hobo-41321f31`, `hobo` | PR job ran |
| 06:18:37–06:25:57 | `hobo-c544e34e`, `hobo` | PR job ran |
| 06:21:40–06:22:16 | `hobo-d9afa8f0`, `hobo-trunk` | Pricing started 6 s after a general job ended |
| 06:22:22–06:23:16 | `hobo-200aa381`, `hobo-trunk` | Main full gate started 6 s after Pricing ended |

Pricing therefore waited **3 m 14 s** after queueing even though the merge-group job had ended before it queued. It started only when general capacity freed; Main then serialized behind Pricing for another **42 s** instead of taking the trunk slot Pricing had left conceptually free.

The code path was completion reconciliation in `hosted-runtime.ts`. It asked GitHub whether a lease's job had completed only when `actualJobId > 0`. Before the poller attributes the job to its runner, that field is zero. If the runner-exit marker is also absent or cannot be probed, the original job's completion never authorizes reconciliation, so its `running` lease continues to consume offer concurrency and its container continues to count against `slots`. The failing regression reproduces exactly that state: the merge-group job is completed on the same runner, `actualJobId` is still zero, and no exit marker is available. The old code kept the lease active; queued trunk work could not reserve until another job released capacity.

For a trunk-labelled lease, reconcile now falls back to the original `jobId` when no actual job has been attributed. It force-stops only when GitHub says that job is completed **and its `runner_name` exactly matches the lease**. A swapped lease still checks its actual job, so this cannot kill the different job that borrowed its runner. General leases retain the exact-assignment requirement and incur no additional reads. The runner-exit marker remains the immediate path; the trunk completion check is the next-tick fallback when assignment attribution or the marker is unavailable.

The slot-accounting and admission-order candidates needed no change. A trunk job may already reserve a free general slot, while general work cannot borrow trunk capacity in strict mode. The incident regression now proves that Main launches while Pricing remains running as soon as a general runner exits. Prewarm remains lease-free and outside slot accounting.

A trunk job that cannot obtain a lease for more than **10 s** now emits one structured `hobo_ci_trunk_wait` event per wait episode, with `reason: "lease-capacity"`, `waitedMs`, `repository`, `runId`, and `jobId`. Wait state is shared across relay ticks and cleared when the job reserves or leaves the queue. This distinguishes lease starvation from GitHub polling and container launch delays in daemon logs.
