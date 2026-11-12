---
type: CI Performance Finding
title: "Finding 125: main shard parallel admission"
description: "Run 43161009890 passed in 12m48s but workspace shards started ~1–2 minutes apart despite ~9.7 GiB MemAvailable and three launch slots."
tags: [hobo, ci, performance, shards, admission, memory, main-gate]
---

# Finding 125: main shard parallel admission

## Evidence (before)

Main Fabric run [43161009890](https://github.com/Hobo-Labs/HoBo/actions/runs/43161009890) on `e0051f2e4` (**12m48s**).

| Observation | Detail |
| --- | --- |
| Shard 0 | 11:27:25–11:28:05 CST (~40s job) |
| Shard 1 start | 11:29:58 CST (~1m53s after shard 0 finished) |
| Shard 2 start | 11:33:32 CST (~61s after shard 1) |
| Worker telemetry | ~9.7 GiB MemAvailable; **three** concurrent container slots |
| Plan → full gate | ~75s pickup gap (fabric phase ordering; unchanged here) |

## Cause

1. **OS headroom was evaluated per job without subtracting live container RSS**, so a finishing shard could block siblings on stale contention signals while MemAvailable still admitted another standard trunk job.
2. **Unlaunched-reservation backlog release** used raw `HOBO_CI_WORKER_SLOTS` only. With a deep pending queue (plan, deps, full gate, shards), `admission-backlog` could drop an extra shard reservation even when memory headroom still fit another parallel launch.
3. **Shard wait reasons were sparse** — trunk waits logged only after 10s; memory waits deduped by signature with no shard index.

`HOBO_CI_WORKER_TRUNK_SLOTS=1` still limits **fleet defer** when mesh reports absorb capacity; it is not lowered here.

## Fix

- **`memoryAdmitParallelCount`** (`@hobo/ci`): derives parallel standard-class admits from MemAvailable − `n×request` ≥ reserve + volatility.
- **Memory admission** subtracts **launching** container RSS from OS headroom before admitting the next trunk job.
- **`parallelLaunchCapacity`** on the relay: feeds unlaunched-release `launchSlots` with the memory-derived cap (bounded by worker slots).
- **Telemetry**: `hobo_ci_main_shard_admission_hold` on every hold/wait for `Main workspace test shard *` (reason, shard index, defer/hold metadata).

## Success criteria (next main push)

- Shard **start skew** &lt; **15s** when `memoryAdmitParallelCount ≥ shard count` and CPU headroom fits.
- Workspace phase wall time ≤ **slowest single shard** (parallel, not serial sum).
- Logs: one `hobo_ci_main_shard_admission_hold` line per blocked shard per dispatch pass with explicit reason.

## Verification

- `packages/ci/test/fleet-capacity.test.ts` (`memoryAdmitParallelCount`)
- `packages/ci-gh-actions/test/main-shard-parallel-admission.test.ts`
- `packages/ci-gh-actions/test/github-job-poller.test.ts` (parallel reserve integration)
