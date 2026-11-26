---
type: CI Performance Finding
title: "Finding 152: two-second job poll and hard-linked deps staging"
description: "Main fabric ran 3m25s–3m31s on about 90 s of step time; the box polled GitHub every 5 s and staged the deps layer by moving trees. The poll default drops to 2 s and staging hard-links; overflow and byte floors are covered by main."
tags: [hobo, ci, performance, pickup, poll, deps-image]
---

# Finding 152: two-second job poll and hard-linked deps staging

This finding was first written as "storage overflow, byte floors, imminent preemption, queue pickup" and was numbered 86 on its branch. `main` solved overflow and byte floors another way before the branch merged, and preemption is not part of this change; the sections below say which is which.

## Context

[Finding 151](./0151-deps-image-builds-take-a-storage-grant-on-an-idle-box.md) covers inode admission. Production still needed byte floors, somewhere for a job to go when the box is full, and faster job pickup so main fabric stays under **3 minutes** wall time.

Measured baseline (user report): main fabric **3m25s–3m31s** with about **90s** of step time, so about **115s** of overhead (poll, admit, container start, registration).

## What main already does

**Byte floors per job class.** Admission reserves bytes beside inodes on each device ([finding 90](./0090-release-enospc-byte-admission.md)). The table is `STORAGE_CLASS_RESERVES` in `storage-job-classes.ts`:

| Job class | Work bytes | Docker bytes | Work inodes | Docker inodes |
|---|---:|---:|---:|---:|
| light | 2 GiB | 1 GiB | 80k | 50k |
| standard | 8 GiB | 6 GiB | 180k | 170k |
| heavy | 12 GiB | 8 GiB | 200k | 170k |
| deps_build | 0 | 24.2 GiB | 0 | 210k |
| runner_image | 4 GiB | 16 GiB | 40k | 220k |
| release_trunk | 18 GiB | 14 GiB | 220k | 200k |

**A full box hands work to the fleet.** A main trunk job the box cannot start is deferred to the fleet mesh ([finding 111](./0111-trunk-headroom-fleet-defer.md), [finding 119](./0119-main-trunk-fleet-pickup-and-admission.md)), and with `HOBO_CI_FLEET_ROUTES=1` the relay marks a pressured box's offers unhealthy so new jobs ask another provider for a runner.

**A poll that accepts jobs runs a tick.** The daemon dispatches as soon as a poll takes a job in, without waiting for the next reconcile tick ([finding 99](./0099-main-gate-job-pickup-latency.md)).

Three parts of the branch are therefore not in this change:

- **Relay storage-overflow spill.** The branch reserved a refused job on an ARC or GitHub-hosted offer from inside the relay's reserve loop. `fleet-storage-spill.ts` keeps the pure selection functions and their tests; nothing calls them.
- **Imminent-pressure preemption.** The branch stopped the lowest-ranked running job when free inodes or bytes fell under a floor. No job is preempted for storage.
- **A poll on every reconcile tick.** With main's poll-then-tick, a tick that also polled would loop poll → tick → poll for as long as each poll accepts a job.

## What this change adds

1. **`HOBO_CI_JOB_POLL_MS` defaults to 2000** (minimum 2000; both were 5000). Every list read still sends its cached ETag, so an unchanged list is a 304 that does not count against the primary rate limit.
2. **Deps staging hard-links.** The deps Dockerfile stages each `node_modules` tree into `/opt/hobo-deps` with `cp -al` and removes the source, where it used to `mv` the tree.

| Mechanism | Before | After |
|---|---|---|
| Job poll interval | 5 s default, 5 s minimum | 2 s default, 2 s minimum |
| Deps image staging | `mv` each tree into `/opt/hobo-deps` | `cp -al` from the install tree, then `rm` the source |
| Job `node_modules` | host store plus `/opt/hobo-deps` symlink | unchanged |
| Store and caches | host `/pnpm-store`, BuildKit `type=cache` on the deps build | unchanged |

Upper bound on pickup savings: a queued job waits at most 2 s for the next poll where it waited at most 5 s, so about **1.5 s** less on average per queue wait and **3 s** less at worst. On the two-job main path that is a few seconds, not the whole gap to three minutes; dispatch latency after a job is taken in is [finding 99](./0099-main-gate-job-pickup-latency.md)'s subject.

## Verification

- `packages/ci-gh-actions/test/worker-store.test.ts`: the 2 s default and minimum.
- `scripts/test/ci-deps-image-contract.test.ts`: the `cp -al` install stage.
- `packages/ci-gh-actions/test/fleet-storage-spill.test.ts`: the unwired selection functions.

## Box rollout

After deploy, leave `HOBO_CI_JOB_POLL_MS` unset for the 2 s default, or set it explicitly. `hobo_ci_isolated_worker_started` logs the `jobPollMs` in effect.
