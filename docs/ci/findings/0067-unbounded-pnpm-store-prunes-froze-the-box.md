---
type: CI Performance Finding
title: "Finding 67: Unbounded pnpm store prunes froze the box"
description: "Overlapping isolated-worker ticks spawned unbounded pnpm store prunes and stalled CI jobs for over an hour."
tags: [hobo, ci, performance]
---

# Finding 67: Unbounded pnpm store prunes froze the box

## Evidence

The box froze for over an hour with load average around 218. Fifty-three `pnpm store prune --store-dir /home/box/.cache/hobo-ci/pnpm-store` processes ran concurrently, and killing them produced ten more. Jobs stalled from 01:42Z for over an hour. Work-directory failures from 01:32–01:42Z immediately preceded the stall, caused by overlapping lease reconcilers operating on the same jobs.

## Cause

Three defects compounded:

1. The daemon's two-second interval did not check `tickInFlight`. A slow tick therefore overlapped the next tick, including its lease reconciliation, launches and storage maintenance.
2. Since inode-reserve admission began calling storage maintenance under soft pressure or reserve shortage, every overlapping tick with zero active leases could await another pnpm store prune, each lasting up to 300 seconds.
3. `execFile` with a timeout killed only pnpm's direct child. Its descendants could survive and continue consuming host resources after the timeout.

## Fix

Worker ticks are single-flight, so reconciliation and launches cannot overlap. Admission-time maintenance no longer prunes pnpm; only the explicit scheduled GC path can request it, with no active leases and a fresh idle check that also requires zero running containers mounting the store. Admission refuses new work while a prune is in flight.

Pruning itself is single-flight per daemon and guarded cross-process by `pnpm-store-prune.lock`, whose live owner is checked before a stale lock is replaced. `pnpm-store-prune.stamp` persists the last prune start across restarts and enforces a six-hour minimum interval, including after failure. The stamp is written before spawn. The prune runs detached in its own process group; the unchanged 300-second default timeout kills that whole group with `SIGKILL`. Prune outcomes are logged through `hobo_ci_pnpm_store_prune`, except routine rate-limit skips.

## Verification

Unit tests cover concurrent callers, live and stale locks, malformed locks, persisted rate limits after success and failure, busy stores, process-group timeout kills, admission exclusion during pruning, GC-only pruning and single-flight ticks. No box deploy or live prune was performed here.
