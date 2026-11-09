---
type: CI Performance Finding
title: "Finding 41: every same-process auth.md lock waiter paid a 25 ms poll"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 41: every same-process auth.md lock waiter paid a 25 ms poll

Merge-group run **41860035056** timed out `test/auth-md-state-concurrency.test.ts` after **10 s** under box load. The test runs three concurrent deployment bindings followed by three concurrent infrastructure claims. Every contender polled the SQLite `BEGIN EXCLUSIVE` lock every 25 ms, so releasing a same-process holder did not wake the next waiter directly.

Three-run medians from `packages/hobo` used `pnpm exec vitest run test/auth-md-state-concurrency.test.ts --reporter=dot`. CPU load was six busy loops; IO load repeatedly wrote and fsynced a 2,000 MiB temporary file. Wall time includes Vite transform/import and therefore remains host-sensitive; the test body isolates the lock and file operations.

| Load | Before test body | After test body | Before wall | After wall |
|---|---:|---:|---:|---:|
| Idle | **112 ms** | **12 ms** | 2.148 s | 2.662 s |
| Six CPU hogs | **116 ms** | **19 ms** | 4.121 s | 5.432 s |
| IO writer | **124 ms** | **22 ms** | 2.835 s | 2.545 s |

Temporary instrumentation on the idle path attributed about **105 ms** to four 25 ms sleeps, **11 ms** to the six locked file-operation sections, and **0.1–0.3 ms** to each SQLite open plus `BEGIN EXCLUSIVE`. The remaining wall time was module transform/import, not lock acquisition.

`acquireLocalStateLockQueued` now keeps an in-process FIFO keyed by resolved lock path. Only its head contends for SQLite; the other callers wait on promises without timers. Release synchronously starts the next head. A head contending with another process retains the bounded 120 s deadline and 25 ms retry, including the existing `LocalStateLockBusyError` deadline behavior. The synchronous local-deployment lock caller is unchanged. Registration-directory mkdir/chmod now happens once during lock preparation rather than in every save; owner-only modes and atomic temporary-file-plus-rename writes remain unchanged.

Unit coverage proves FIFO handoff without timer scheduling, release after a holder throws, and single-head cross-process retry/deadline behavior with an injected clock, lock, and scheduler. The original concurrency test remains unchanged and its test body stays well below 1 s under all three measured conditions.
