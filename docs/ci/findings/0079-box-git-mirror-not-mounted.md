---
type: CI Performance Finding
title: "Finding 79: box git mirror not mounted"
description: "Main full gate checkout stayed at ~6 s because hobo-checkout always missed the Phase 2 mirror."
tags: [hobo, ci, performance, checkout, git, worker]
---

# Finding 79: box git mirror not mounted

## Symptom

Green Main Fabric [42038895458](https://github.com/Hobo-Labs/HoBo/actions/runs/42038895458)
job [127284160413](https://github.com/Hobo-Labs/HoBo/actions/runs/42038895458/job/127284160413)
on `8ba22638` (#1749) paid **Checkout ~6 s** on Main full gate and again on the CI deps layer
job. Worker logs showed:

```
hobo_ci_git_mirror=miss reason=no candidate mirror exists
```

`hobo-checkout` already probes `HOBO_CI_GIT_MIRROR` and
`/var/lib/hobo-ci/git/<owner>/<repo>.git`. Nothing on the box created or mounted that path.

S0 gate set is **2 s** (do not cut). Install is finding 78 (#1750). This finding is checkout only.

## Cause

[docs/ci/oci-layer-plan.md](../oci-layer-plan.md) Phase 2 specified a worker-owned bare mirror,
per-run `git fetch` of the admitted SHA, and a read-only container mount. The job-side probe
landed with Phase 1. The worker fetch, mount, and `HOBO_CI_GIT_MIRROR` env did not.

`actions/checkout` with `fetch-depth: 0` then unshallowed from GitHub (`+refs/heads/*` and
`+refs/tags/*`) even though the box had already cloned the same objects for earlier jobs.

## Fix

`createBoxGitMirror` owns `/var/lib/hobo-ci/git/<owner>/<repo>.git`:
- clone `--bare --filter=blob:none` once, then `--no-filter` backfill of `main`;
- one writer per repository;
- `git fetch --no-filter origin <sha>:refs/hobo/sha/<sha>` before `docker create`
  (never a branch name for a PR / fork object);
- `gc.auto=0`;
- mount `:ro` at the same path and set `HOBO_CI_GIT_MIRROR`.

A miss logs `hobo_ci_git_mirror` and the job still checkouts from GitHub.
`HOBO_CI_GIT_MIRROR=0` disables the feature.

## Residual

Weekly `git maintenance` GC is not scheduled here. Slot waits (`prCapWithTrunk:1`, inode
outstanding) are the next wall-time arm after checkout. First fetch of a never-seen SHA still
pays GitHub once.

## Verification

`packages/ci-gh-actions/test/git-mirror.test.ts` — hit, miss, SHA-only refs, serialized writers.
`test/isolated-worker-parallel.test.ts` — `:ro` mount and `HOBO_CI_GIT_MIRROR`.
`test/isolated-worker-launch-thrash.test.ts` — ensure-before-create.
Expected Main full gate checkout: **~1–2 s** on a hit (`hobo_ci_git_mirror=hit`).
