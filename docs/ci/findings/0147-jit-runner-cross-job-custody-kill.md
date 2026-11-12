---
type: CI Performance Finding
title: "Finding 147: jit runner cross job custody kill"
description: "A release-held box JIT runner took a different hobo-labeled job on another workflow run; reconcile retired the lease with stale run metadata while GitHub still showed the cross-assigned job in progress."
tags: [hobo, ci, jit, runner, custody, orphan, box-worker, main-fabric, release]
---

# Finding 147: jit runner cross job custody kill

## Evidence

Main Fabric run [43302513633](https://github.com/Hobo-Labs/HoBo/actions/runs/43302513633) job `131490555668` (Main workspace test shard 0) ended after ~11m24s with “The self-hosted runner lost communication with the server”. The box worker had started JIT lease `237f4d7d` for release GHCR publish run [43275965551](https://github.com/Hobo-Labs/HoBo/actions/runs/43275965551) job `131490897930` (held for memory headroom). GitHub assigned shard 0 to the same `hobo`-labeled runner. The worker logged `hobo_ci_orphan_job_detected` for shard 0 with the **release** run id, then retired lease `237f4d7d` (workdir delete + runner deregister) mid-test.

## Root cause

1. `adoptRunnerAssignment` stopped syncing `originalRunId` when `actualJobId` already matched GitHub but the lease still carried the reserved release run id. Orphan telemetry and reconcile guards read stale metadata.
2. The `ghost-runner-active-binding` reconcile path deregistered the runner and forced stop while `runnerCustodyHoldsActive` was true for the cross-assigned main-fabric job (container not running ≠ job finished).
3. `RUNNER_EXITED_PATH` fast retire could ignore adoption custody when GitHub correlation failed on the stale `preferRunIds` run.

Poll coalescing (#1819) and lease cancel grant release (#1797) were not the primary triggers.

## Fix

`packages/ci-gh-actions`: pin `actualJobId` / `originalRunId` to GitHub’s served job (including run-id-only drift), withdraw the reserved queued job once on custody transfer, refuse stop/deregister while active custody holds, resolve orphan run ids from GitHub, and follow `actualJobId` for storage grant maintain/release.

## Gates

- `packages/ci-gh-actions/test/jit-hobo-label-reassignment.test.ts`
- `packages/ci-gh-actions/test/runner-lease-adoption.test.ts`
