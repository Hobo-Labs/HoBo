---
type: CI Performance Finding
title: "Finding 95: worker custody orphan live shards"
description: "Foreign-runner yield and orphan reconcile killed live main workspace shard containers after custody transfer; retain active box assignments and dedupe orphan removal."
tags: [hobo, ci, performance, box-worker, custody, orphan]
---

# Finding 95: worker custody orphan live shards

## Evidence

Main Fabric run [42980971675](https://github.com/Hobo-Labs/HoBo/actions/runs/42980971675) on `7f0b9a2d4` (#1866) started ~07:38 UTC. **Main workspace test shard 0/1** ran on box runners `hobo-10886b73-…` and `hobo-8054f221-…` while journal lease count dropped to **0** right after `hobo_ci_jit_runner_custody_transferred`. Orphan reconcile logged `hobo_ci_container_orphan_remove_failed` (`removal … already in progress`); GitHub kept both shards `in_progress` without containers.

## Cause

1. **Foreign-runner yield** cancelled box leases when a stale REST `runner_name` said another fleet runner held the job, even though run-job correlation showed the same job **`in_progress` on our `hobo-<lease>` runner**.
2. **Orphan sweep** issued parallel `docker rm` against containers already removing.

## Fix

- Retain any lease whose runner **`holdsActive`** GitHub assignment before foreign yield cancels (same job or cross-run transfer).
- Pin **`originalRunId`** when custody transfers so assignment scans prefer the served run.
- Orphan reconcile: strengthen **`containerCustody`** GitHub liveness; skip Docker **`removing`**; dedupe in-flight removals.

## Follow-up (Fabric 42985846610)

Shard 0 on box `hobo-9a6eef27` failed `start-container.test.ts` (10s Vitest timeout, ~16s wall): four reaper retries used `node:timers/promises` delay, which ignores fake timers (~9s real backoff). Injectable `betweenAttemptsMs` (0 in unit tests) and global `setTimeout` for timer-driven cases.

## Proof

- `packages/ci-gh-actions/test/runner-custody-live-work.test.ts`
- `packages/ci-gh-actions/test/jit-arc-trunk-reassignment.test.ts` (`originalRunId` follows served run)
- `packages/ci-gh-actions/test/poll-readmission-guard.test.ts`
