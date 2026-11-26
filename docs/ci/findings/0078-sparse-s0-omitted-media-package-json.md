---
type: CI Performance Finding
title: "Finding 78: sparse S0 omitted media/package.json"
description: "Main full gate Install stayed at ~10 s after #1748 because checkout-key was unavailable."
tags: [hobo, ci, performance, checkout, sparse, deps]
---

# Finding 78: sparse S0 omitted media/package.json

## Symptom

Green Main Fabric [42038895458](https://github.com/Hobo-Labs/HoBo/actions/runs/42038895458)
job [127284160413](https://github.com/Hobo-Labs/HoBo/actions/runs/42038895458/job/127284160413)
on `8ba22638` (#1749) had wall **63 s** and Main full gate **36 s**. S0 gate set was **2 s**.
The longest remaining arm was **Install dependencies** (13:48:07–13:48:17Z, **10 s**).

```
deps layer miss (checkout-key): job=vda125e5eb8a2-7426db5492c7cb83, checkout=unavailable
```

Verify sibling links skipped. The GHCR-keyed payload was present (`job=vda125e5…`); the
checkout could not hash it.

## Cause

Finding 73 excluded `media/` from the S0 cone so blobless checkout would not fetch media
assets. `media` is still a workspace importer in `pnpm-workspace.yaml`. `depsKeyForRoot`
reads every lockfile importer's `package.json`. Missing `media/package.json` throws;
`deps-layer.mts check` swallowed that as `checkout=unavailable` and treated it as an
ordinary miss. Install then ran even though the lockfile-keyed layer was already on the
box.

#1738/#1748 S0 times (4 s / 18 s / 30 s) were command-scope, not this miss. After #1749
S0 is **2 s**; this finding is the install arm only.

## Fix

Sparse S0 lists `media/package.json` as a nested file so `depsKeyForRoot` can
hash it. The `media/` asset tree stays out of the cone. `check` logs the thrown
path on stderr so the next miss is diagnosable. Finding 80 covers materializing
that nested file under cone-mode sparse-checkout (`--skip-checks`).

## Residual

Checkout is still ~6 s (blobless `fetch-depth: 0` plus the near-full cone; box bare mirror
is still Phase 2, `hobo_ci_git_mirror=miss`). A lockfile or toolchain key change still
pays a real install.

## Verification

`scripts/test/s0-checkout-cone.test.ts` requires `media/package.json` in the S0 file list
and `S0_INSTALL_REQUIRED_PATHS`, and rejects `media/src/index.ts`.
`scripts/test/deps-layer.test.ts` requires `checkout-key` misses to name the missing file.
Expected Main full gate install: skip on a layer hit (Verify sibling links runs; Install
does not).
