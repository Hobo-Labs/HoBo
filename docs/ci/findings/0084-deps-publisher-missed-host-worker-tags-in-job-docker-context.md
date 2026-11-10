---
type: CI Performance Finding
title: "Finding 84: deps publisher missed host worker tags in job docker context"
description: "Isolated ci-deps-publish jobs inspect the daemon via the mounted socket but often lack hobo-ci-worker version tags the box host already has, so build-deps failed before GHCR push."
tags: [hobo, ci, deps-layer, release, docker]
---

# Finding 84: deps publisher missed host worker tags in job docker context

## Evidence

Main deps publisher [42854070994](https://github.com/Hobo-Labs/HoBo/actions/runs/42854070994) on `2d1cc0df` (2026-11-10) failed in under two seconds after deciding to build:

```text
missing toolchain image hobo-ci-worker:v17247f454c13 and no versioned tag on hobo-ci-worker:local
```

The same workflow on [42851161898](https://github.com/Hobo-Labs/HoBo/actions/runs/42851161898) had briefly seen that toolchain and started a deps build; a later publisher attempt could not `docker image inspect` the versioned worker or read a `v*` tag from `:local`, even though operators could still see the image on the host.

## Cause

`build-deps.sh` assumed that a mounted `/var/run/docker.sock` implies the computed `hobo-ci-worker:<version>` tag (or a versioned tag on `:local`) is already present in **this** client context. Under load or after GC, isolated job containers can talk to the host daemon yet miss the tags the host operator sees (classic image store + concurrent retags). The publisher had `GHCR_TOKEN` but did not run `scripts/ci/ensure-ci-worker-image.mts` to pull or retag before failing closed.

## Fix

`build-deps.sh` calls `ensure-ci-worker-image` when the computed toolchain is absent (exporting `GITHUB_TOKEN` from `GHCR_TOKEN` when needed). `publish-deps.sh` exports that token before delegating to `build-deps.sh`.
