---
type: CI Performance Finding
title: "Finding 80: sparse S0 nested file pathspec"
description: "Main full gate on 9705aaecc failed checkout: media/package.json is not a cone-mode path."
tags: [hobo, ci, performance, checkout, sparse]
---

# Finding 80: sparse S0 nested file pathspec

## Symptom

Main push Fabric [42054416861](https://github.com/Hobo-Labs/HoBo/actions/runs/42054416861)
job [127338776181](https://github.com/Hobo-Labs/HoBo/actions/runs/42054416861/job/127338776181)
on `9705aaecc` (#1750) failed **Checkout (sparse S0, full history)** in 7 s:

```
hobo_ci_git_mirror=miss reason=no candidate mirror exists
error: pathspec 'media/package.json' did not match any file(s) known to git
sparse checkout failed after 3 attempts (partial clone / promisor fetch)
```

Install and S0 never ran. The worker had just restarted (empty workdir).

## Cause

Finding 78 added `media/package.json` to the S0 file list so `depsKeyForRoot`
can hash it. `hobo-checkout` splits that path out of the directory cones (cone
mode would treat `media/` as a tree and fetch assets) and then ran
`git checkout HEAD -- media/package.json`. Cone-mode sparse-checkout only
tracks directories. On a warm box leftover objects hid the miss; on a fresh
worker the pathspec does not match.

## Fix

For nested S0 files, `git sparse-checkout add --skip-checks -- <file>` then
`git checkout HEAD -- <file>`. Root manifests stay on the existing checkout.
The `media/` asset tree stays out.

## Residual

Checkout is still ~6 s (`hobo_ci_git_mirror=miss`). Box bare-mirror remains
the next arm.

## Verification

`scripts/test/s0-checkout-cone.test.ts` requires the skip-checks materialize
path and still rejects `media/src/index.ts`.
