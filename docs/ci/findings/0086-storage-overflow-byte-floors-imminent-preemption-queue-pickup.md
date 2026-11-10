---
type: CI Performance Finding
title: "Finding 86: storage overflow, byte floors, imminent preemption, queue pickup"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 86: storage overflow, byte floors, imminent preemption, queue pickup

## Context

Finding 85 closed proactive **inode** admission and bin-pack. Production still needed **byte** floors, overflow when the box is full (no loop back to hobo relay), imminent-failure preemption, and faster job pickup so main fabric stays under **3 minutes** wall time.

## Byte floors per job class (alongside inodes)

| Job class | Work bytes | Docker bytes | Work inodes | Docker inodes |
|---|---:|---:|---:|---:|
| light | 2 GiB | 1 GiB | 80k | 50k |
| standard | 8 GiB | 6 GiB | 180k | 170k |
| heavy | 12 GiB | 8 GiB | 200k | 170k |
| deps_build | 0 | 28 GiB | 0 | 420k |
| runner_image | 4 GiB | 16 GiB | 40k | 220k |

Admission uses `max(HOBO_CI_STORAGE_INODE_SAFETY_MARGIN, volatility margin)` for inodes and a **2 GiB** byte safety floor (`BYTE_SAFETY_MARGIN_FLOOR`). `reserveShortage` and `binPackConcurrent` take the **tighter** of inode and byte headroom per device.

Example bin-pack (shared device, **900k** free inodes, **80 GiB** free bytes, margin **50k** inodes / **2 GiB** bytes, no grants):

- **standard:** `min(floor((900k−50k)/350k), floor((80−2−0)/14)) = min(2, 5) = **2**` concurrent jobs.
- **heavy:** `min(floor(850k/370k), floor(78/20)) = min(2, 3) = **2**`.

Logged on each admit: `hobo_ci_storage_capacity` (`maxConcurrentStandard`, `maxConcurrentHeavy`, `maxConcurrentLight`, `observedFreeBytes`).

## Storage closed → ARC / GitHub overflow (no hobo loop)

When box storage admission refuses a job (`admit` false or `isAdmissionOpen` false) and the connection is **not** `isolatedOnly`, `HostedRelay.dispatchPending` calls `reserveStorageOverflow`: `accountForStorageOverflowReserve` disables `hobo-box-worker` / isolated-container offers, then `store.reserve` on the trimmed account. Success emits `hobo_ci_storage_overflow_spill` (offer id, provider, runner). Isolated-only connections still wait (`hobo_ci_trunk_wait` / storage) — they do not loop on the relay.

Selection: `selectStorageSpillBackend` → `selectFleetBackend` with `hoboFreeSlots: 0` so only overflow members (ARC `kubernetes` + `gh-actions`, or `github` hosted) qualify.

## Inode efficiency (before → after)

| Mechanism | Before | After |
|---|---|---|
| Deps image staging | `mv` / copy tree into `/opt/hobo-deps` | `cp -al` from BuildKit store mount, then `rm` source (shared inode budget on store) |
| Job `node_modules` | host store + `/opt/hobo-deps` symlink (existing) | unchanged |
| Workdir lifecycle | retire → sweeper | retire on container stop + **immediate** sweeper trigger (`scheduleRetiredSweep` each cleanup) |
| Sparse checkout | main `S0_SPARSE_PATHS` | unchanged (full list in `hobo-ci.yml` `main-gate`) |
| Store / caches | host `/pnpm-store`, BuildKit `type=cache` on deps build | unchanged; BuildKit verify uses tmpfs store |
| Concurrent cap | fixed `HOBO_CI_WORKER_SLOTS` | `min(slots, binPackSlots(class))` from **live** statvfs headroom |

## Queue / pickup (main under 3 min)

Measured baseline (user report): main fabric **3m25s–3m31s** with ~**90s** of step time → **~115s** overhead (poll, admit, container start, registration).

Changes in this closeout:

1. **`HOBO_CI_JOB_POLL_MS` default 2000** (min 2000); was 5000.
2. **Poll on every daemon reconcile tick** before launch (`runJobPoll()`), so a freed slot is not stuck until the next poll timer.

Upper-bound pickup savings vs old defaults: **≤3s** average per queue wait (2s vs 5s interval) plus up to **one tick** of reconcile latency. On a two-job main path, expect **~6–15s** faster wall time when the box is idle — enough to pull **3m28s → ~3m12s** class runs under 3m with unchanged step budgets. Heavier wins need fewer serial image/deps jobs (already parallelized: `main-gate` does not `needs: ci-deps-image`).

## Imminent external pressure

Each tick: after `probeHostCapacity`, `evaluateImminentPressure` compares observed free inodes/bytes to **floor = outstanding grants + margin + light-class reserve + buffer** (`IMMINENT_INODE_BUFFER`, byte quarter-margin). When true, the daemon preempts the **lowest admission rank** (highest rank number) lease via `host.reconcile(leaseId, true)` and logs `hobo_ci_imminent_pressure_preempt` with floors and observed headroom.

## Verification

- `packages/ci-gh-actions/test/fleet-storage-spill.test.ts`
- `packages/ci-gh-actions/test/storage-admission.test.ts` (bytes + proactive ordering)
- `packages/ci-gh-actions/test/github-job-poller.test.ts` — overflow reserve when storage blocks
- `scripts/test/ci-deps-image-contract.test.ts` — `cp -al` install stage
- `packages/ci-gh-actions/test/worker-store.test.ts` — 2s default poll

## Box rollout

Set on the worker after deploy: confirm `HOBO_CI_JOB_POLL_MS=2000` (or unset for default). Watch `hobo_ci_storage_overflow_spill`, `hobo_ci_imminent_pressure_preempt`, and `hobo_ci_storage_capacity` on the next main push for live concurrent caps.
