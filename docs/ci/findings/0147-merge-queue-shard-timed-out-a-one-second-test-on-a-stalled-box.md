---
type: CI Performance Finding
title: "Finding 147: merge queue shard timed out a one-second test on a stalled box"
description: "Merge-group run 43318507956 removed #1952 from the queue: a ci-ado test that waits the real one-second poll took 10.7 s on a box runner and hit Vitest's five-second default."
tags: [hobo, ci, performance, merge-queue, vitest, timeout, box, shards]
---

# Finding 147: merge queue shard timed out a one-second test on a stalled box

## Evidence

Merge-group run [43318507956](https://github.com/Hobo-Labs/HoBo/actions/runs/43318507956) (2026-11-12, 22:17–22:40Z) held [#1952](https://github.com/Hobo-Labs/HoBo/pull/1952) alone on main `049ecb0ea` and failed, so the queue dropped the PR.

| Signal | Value |
| --- | --- |
| Failed job | Workspace test shard 0 ([131534635271](https://github.com/Hobo-Labs/HoBo/actions/runs/43318507956/job/131534635271)), box runner `hobo-<lease-uuid>`; PR impact gate failed as a knock-on |
| Test | `packages/ci-ado/test/edges/live.test.ts` — *supports the real process environment and default polling interval* |
| Error | `Test timed out in 5000ms` after 10.7 s |
| Same inputs, an hour earlier | the PR's own shard 0 (GitHub-hosted) ran the identical turbo task hash `41c3e04d684d6c7d`: test 1.0 s, task 19 s |
| Box | job waited 10m11s for a runner; the turbo task took 6m40s around a 28.9 s Vitest run |

The PR's diff touches nothing under `packages/ci-ado`.

## Cause

1. **The test waits real time.** It is the one case that exercises the default 1000 ms poll (`src/live.ts`), so it sleeps a second by design and has four seconds of slack.
2. **The package had Vitest's default budget.** `packages/ci-ado/vitest.config.ts` set no `testTimeout`, so its cases ran with 5 s where the root config and other CI packages use `HOBO_TEST_TIMEOUT ?? 10_000`.
3. **The box stalled.** A 1 s wait took 10.7 s. Whether the worker was running the admission changes of [finding 142](./0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md) was not established, and no host metrics were read.

## Fix

- `packages/ci-ado/vitest.config.ts`: `testTimeout` and `hookTimeout` follow `HOBO_TEST_TIMEOUT ?? 10_000`.
- The real-poll case gets its own 60 s budget, still raisable by `HOBO_TEST_TIMEOUT`. Its assertions are unchanged.

## Not changed

The stall itself. This makes one test survive it; the box side is findings [101](./0101-shared-box-memory-stall-on-shard-1.md) and 142.

## Verified

- `@hobo/ci-ado` full suite (`vitest run`): 9 files, 301 tests pass; typecheck and lint clean.
- Not reproduced under load: the 60 s budget is chosen against the 10.7 s observed, not measured on a stalled box.
