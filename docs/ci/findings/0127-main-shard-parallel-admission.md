---
type: CI Performance Finding
title: "Finding 127: main shard parallel admission"
description: "Run 43161009890 passed in 12m48s but workspace shards started ~1–2 minutes apart despite ~9.7 GiB MemAvailable and three launch slots."
tags: [hobo, ci, performance, shards, admission, memory, main-gate]
---

# Finding 127: main shard parallel admission

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

1. **Unlaunched-reservation backlog release** treated worker slot count as total capacity while ignoring memory-derived parallel admits, and could clamp a zero memory cap up to one slot. With a deep pending queue, `admission-backlog` could drop a shard reservation early or retain one peers should absorb.
2. **Same-run shard telemetry** duplicated holds (fleet defer + `reportTrunkWait`, memory deny + trunk wait) within one dispatch pass.
3. **Shard wait reasons were sparse** — trunk waits logged only after 10s; memory waits deduped by signature with no shard index.

`HOBO_CI_WORKER_TRUNK_SLOTS=1` still limits **fleet defer** when mesh reports absorb capacity; it is not lowered here.

## Fix

- **`memoryAdmitParallelCount`** (`@hobo/ci`): derives parallel standard-class admits from MemAvailable − `n×request` ≥ reserve + volatility.
- **`effectiveParallelLaunchSlots`**: unlaunched-release capacity = `min(worker slots, live containers + memory parallel admits)` with no zero→one clamp.
- **`parallelLaunchCapacity`** on the relay: feeds that helper from `memoryAdmitParallelCount` (reserve 2048 + volatility 1024 unchanged).
- **Telemetry**: `hobo_ci_main_shard_admission_hold` on every hold/wait for `Main workspace test shard *` (reason, shard index, defer/hold metadata).

## Success criteria (next main push)

- Shard **start skew** &lt; **15s** when `memoryAdmitParallelCount ≥ shard count` and CPU headroom fits.
- Workspace phase wall time ≤ **slowest single shard** (parallel, not serial sum).
- Logs: one `hobo_ci_main_shard_admission_hold` line per blocked shard per dispatch pass with explicit reason.

## Verification

- `packages/ci/test/fleet-capacity.test.ts` (`memoryAdmitParallelCount`)
- `packages/ci-gh-actions/test/main-shard-parallel-admission.test.ts`
- `packages/ci-gh-actions/test/github-job-poller.test.ts` (parallel reserve integration)
