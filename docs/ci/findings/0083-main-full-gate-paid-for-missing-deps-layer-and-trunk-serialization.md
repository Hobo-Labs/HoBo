---
type: CI Performance Finding
title: "Finding 83: main full gate paid for missing deps layer and trunk serialization"
description: "Toolchain label drift on hobo-ci-deps:local dropped HOBO_CI_DEPS_LAYER, forcing a five-minute install; merge-group shards queued behind main push gates on one trunk slot."
tags: [hobo, ci, performance, deps-layer, trunk]
---

# Finding 83: main full gate paid for missing deps layer and trunk serialization

## Evidence

Run [42808187331](https://github.com/Hobo-Labs/HoBo/actions/runs/42808187331) (`3ee194ca`, 2026-11-10):

| Step | Wall time |
| --- | --- |
| Install dependencies | **5m01s** |
| S0 gate set (`agent:check`, affected) | 2m56s |
| Generated-output drift | 2m18s |
| Workspace tests | 76s |
| **Main full gate total** | **14m10s** |

`Check deps layer match` logged `deps layer miss (job-key-mismatch): job=none,
checkout=vda125e5eb8a2-a5ad5f9cde62572c` — not a key hash mismatch, but
`HOBO_CI_DEPS_LAYER` unset because the worker fell back to `hobo-ci-worker:local`
after `hobo-ci-deps:local` lagged the promoted worker toolchain label. CI trace
`turbo-summary-0.json` shows `//#typecheck:root` at **~58s** as the dominant S0
task on a cold graph (`HOBO_TURBO_CONCURRENCY=1`).

Run [42813250105](https://github.com/Hobo-Labs/HoBo/actions/runs/42813250105)
(`0e5a16bb`, #1810) kept **Install dependencies** at **2m50s** with verify
skipped (layer miss). S0 reached **7m12s** before drift.

By contrast, run [42718556692](https://github.com/Hobo-Labs/HoBo/actions/runs/42718556692)
(2026-11-09) spent **12s** on install (layer miss but warm store) and **23s** on
S0 — the ~40–60s fabric the team expects when the deps payload links.

Merge-queue shard jobs (#1766, #1811) timed out of the queue while **Main full
gate** held the single `HOBO_CI_WORKER_TRUNK_SLOTS=1` lease on a two-slot worker.

## Cause

1. **Worker deps selection required a toolchain label match** between
   `hobo-ci-worker:<version>` and `hobo.ci.toolchain` on `hobo-ci-deps:local`.
   A runner-image push without a same-commit deps promotion left a valid payload
   unused; jobs ran on the worker image with `job=none`, skipped linking, and ran
   the full `pnpm-install.mts` path (~5m on a cold `/pnpm-store/v10`).

2. **Admission order did not prefer `merge_group` over `push`** within trunk rank
   (both `TRUNK_RANK` 0, FIFO by `run_started_at`), so a long main push gate
   blocked merge-queue shards on one trunk slot.

3. **Orphan job reconcile on every job-poll interval** (#1810) added GitHub API
   work on the hot path; throttling to at most once per minute keeps recovery
   without amplifying `tick_slow` pressure.

## Fix

- Select `hobo-ci-deps:local` whenever `hobo.ci.deps-key` is present and the
  probe succeeds; log `hobo_ci_deps_toolchain_drift` when labels disagree.
- `deps-layer.mts` resolves the layer key from `/opt/hobo-deps/.hobo-ci-deps-key`
  when `HOBO_CI_DEPS_LAYER` is unset (deps image jobs).
- `trunkEventPriority` orders `merge_group` before `push` at the same rank.
- `HOBO_CI_ORPHAN_RECONCILE_MIN_MS` (default 60s) caps background orphan reconcile.

## Expected result

Main push with a promoted deps image should return to **skip install** (verify
sibling links green), ~12–20s S0 on affected graphs with a warm Turbo cache, and
merge-queue shards should start while an older main push gate is still running
when a second slot exists.
