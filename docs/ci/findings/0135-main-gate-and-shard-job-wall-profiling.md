---
type: CI Performance Finding
title: "Finding 135: main gate and shard job wall profiling"
description: "Run 43181149502 showed a 3m03s Main full gate job wall and a 3m54s Main workspace test shard 0 job wall; profiling shows install, S0 agent:check, and empty-shard artifact upload dominated—not missing test parallelism."
tags: [hobo, ci, performance, main-gate, workspace-shards]
---

# Finding 135: main gate and shard job wall profiling

## Evidence (run 43181149502 / `db90967b8`)

| Job | Wall (`started`→`completed`) | Dominant steps |
|-----|-------------------------------|----------------|
| **Main full gate** | **3m03s** | S0 `agent:check` (affected) **~73s**; `pnpm install` **~40s** (deps layer `job-key-mismatch`); `codegen:check:affected` **~30s**; checkout/setup **~20s** |
| **Main workspace test shard 0** | **3m54s** | **Workspace tests ~2s** (`no workspace tests selected`); **`upload-artifact` (ci-trace) ~3m38s** |

Plan output: `shards=[0]`, `peakShardSeconds=0`, `tests=affected` — CI-only delta `f2bd06ddf..db90967b8` (release workflow + docs/scripts), so Turbo affected had **no package tests**.

Separate from job wall: trunk **pickup** added **~2m** before deps/plan started (see [Finding 134](./0134-main-trunk-pickup-after-route.md)).

## Cause

1. **Shard 0 “slow” job** was an **empty matrix leg** still running checkout + **mandatory trace artifact upload** with negligible Turbo output.
2. **Main full gate** paid a **cold pnpm install** when the deps payload was not mounted (`deps layer miss (job-key-mismatch): job=none`).
3. **S0 gate** ran full affected `agent:check` with **serial relevant-check concurrency (1)** on a 4 GiB trunk class.

## Fix (shipped in companion PR)

- Emit **`shards=[]`** when the main plan has no workspace work; accept **skipped** workspace matrix in **Main full gate (finish)** only when **`main-gate-plan` succeeded** and **`shards=[]`** (`scripts/test/main-gate-finish.test.ts` covers plan failure + skipped shards).
- **Skip ci-trace artifact upload** when zero Turbo runs were recorded (export still writes empty OTLP).
- Main full gate: **`HOBO_CI_DEPS_EXPECTED_KEY`** before `deps-layer check`; **`HOBO_RELEVANT_CHECK_CONCURRENCY=3`** on affected S0.

Further wall-time wins (not in this PR): worker deps mount so `match=true` (drops ~40s install); shard planning from refreshed `workspace-test-durations.json` when tests are non-empty.

## Measure

On a CI-only main push after merge: **no** `Main workspace test shard *` jobs; Main full gate job wall **&lt;2m** when pickup &lt;15s and deps layer hits.

## Verification

- `scripts/test/dependent-tests.test.ts`, `scripts/test/ci-trace-action.test.ts`, `scripts/test/main-workspace-affected.test.ts`, `scripts/test/main-gate-finish.test.ts`
- `node --test scripts/test/ci-trace.test.ts`
- **Protobuf / CUE / PACT:** not applicable.
