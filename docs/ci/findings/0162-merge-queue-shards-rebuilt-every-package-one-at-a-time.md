---
type: CI Performance Finding
title: "Finding 162: merge-queue shards rebuilt every package one at a time"
description: "A merge-group run of HoBo CI Fabric took 16 to 20 minutes because each GitHub-hosted workspace shard rebuilt about 150 unchanged packages with turbo concurrency 1 and an empty cache. A push to main now saves a whole-workspace build cache that every pull request and merge group restores, and the shards run their builds at one task per CPU before the memory-bound test pass."
tags: [hobo, ci, performance, turbo, actions-cache, merge-queue]
---

# Finding 162: merge-queue shards rebuilt every package one at a time

## Measurements

Merge-group run 45261574705 (pull request 2947), on GitHub-hosted runners:

| Stage | Time |
| --- | --- |
| Route runners | about 40 s |
| PR impact plan | about 55 s runner pickup, then 45 s |
| Workspace test shard N | 1.5 to 4 min runner pickup, then 1.5 to 10.5 min |
| PR impact validation (parallel with the shards) | 9 min, S0 gate set 445 s |
| PR impact gate | after the slowest shard |

Shard 6 spent about 1 minute on setup and 543 s on its "Workspace tests" step. Its turbo run (`scripts/ci/dependent-tests.mts --run`) executed about 230 tasks: 43 cache hits and 187 misses, at `--concurrency=1`. Most misses were the `#build` tasks of about 150 packages the change never touched.

- **Concurrency 1.** The workflow sets `HOBO_TURBO_CONCURRENCY: "1"`, and `ci-runner-preflight`'s memory env (`computeJobMemoryConfig`) keeps it at 1 on a 16 GB, 4-CPU hosted runner: four vitest workers with 3043 MB heaps leave no room for a second test task ((4 + 1) × 3043 + 768 MB). The same value also serialized every `tsc` build, which needs a fraction of that memory.
- **No cache to replay.** Hosted runners have no remote turbo cache (`Turbo remote cache not configured`; `turboCache.api` in `.hobo/ci.json` is empty), so `.github/actions/turbo-cache` falls back to `actions/cache`. A merge-group ref reads only its own caches and main's. A push to main whose tree the merge queue already passed runs only Route, Main workspace plan and Main full gate (finish), about 2 minutes, so main never built the workspace and never saved a build cache. The shard restored an unrelated 63 MB cache.

## Fixes

- **Main seeds a whole-workspace build cache.** The `main_build_cache` job runs on every push to main, on the routed runner, with the same checkout, deps layer and install as the workspace shards. It restores the previous main build cache, runs `turbo run build --continue --concurrency=100%` over every package, prunes with `HOBO_TURBO_CACHE_KEEP_DAYS=0` so only this tree's builds stay, and saves under `turbo-<os>-main-build-<lock hash>-<sha>-<attempt>` (turbo-cache `cache-name: main-build`). It is not part of the required set and Main full gate (finish) does not wait for it.
- **Every gate job restores it first.** Turbo-cache input `main-build: "true"` restores the newest `turbo-<os>-main-build-` entry before the job's own and preferred-job caches extract on top. PR impact validation, Workspace test shard, PR affected package lanes, Scripts tests build and Scripts tests set it.
- **Builds at one task per CPU.** `dependent-tests.mts --run` now runs every `build` task of the plan's test graph in its own turbo call first, at `buildTaskConcurrency`: one per CPU, capped by 1024 MB per build after a 768 MB reserve from the job's cgroup or host memory (`HOBO_TURBO_BUILD_CONCURRENCY` overrides it). The test calls that follow are unchanged and replay those builds from the local cache at the memory-derived `HOBO_TURBO_CONCURRENCY`. A repo-wide plan and a `HOBO_TURBO_USE_AFFECTED` run keep their builds inside the test call.

## Hash stability

The cache helps only when a build's task hash on main equals its hash in a shard. `turbo.json` uses `envMode: strict`, no task declares `env`, and every variable the jobs differ on (`HOBO_*`, `NODE_OPTIONS`, `CI`) is in `globalPassThroughEnv`, which turbo leaves out of the hash. `turbo run build --continue --output-logs=errors-only --concurrency=100% --dry=json` with the main job's environment, and the shard's build pass for `@hobo/hobo`, `@hobo/cli` and `@hobo/iac-alchemy` by task id with `NODE_OPTIONS=--max-old-space-size=3043`, `TURBO_SCM_BASE`, `GITHUB_JOB=workspace_tests` and `--anon-profile`, gave identical hashes for all 117 shared build tasks. A whole `turbo run test` graph contains the same 168 real build tasks as `turbo run build`, so the main job builds exactly what the shards and validation can ask for.

## Expected effect

With main's cache restored, an unchanged package's build replays in well under a second, so a shard's build work is the changed packages and their dependents, at four builds at once on a hosted runner. Shard 6's 187 misses become the handful of builds the change reaches plus its test tasks. The shard's 543 s step should fall to the length of its test tasks, about 2 to 4 minutes, which keeps the merge-group run under 10 minutes when runner pickup is at its measured 1.5 to 4 minutes.

## Remaining limits

- A merge group whose base is a main commit whose build cache is still being saved restores the previous main build, so packages that commit changed rebuild.
- Each main push that changes a package saves a new main build cache. GitHub evicts the least recently used caches when the repository passes its 10 GB cache limit, and older main build caches are never read again, so they go first.
- On the box the turbo cache is a shared host directory, so the job neither prunes nor saves there. Only a push to main routed to GitHub-hosted runners seeds the `actions/cache` entry hosted pull request and merge-group jobs read.
- The main build job stays inside the 20-minute job limit every `hobo-ci.yml` job keeps (15 minutes for the build step), so a cold full build that runs longer saves no cache and the next push retries from what the previous one saved.
