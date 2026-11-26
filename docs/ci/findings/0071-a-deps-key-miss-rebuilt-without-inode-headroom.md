---
type: CI Performance Finding
title: "Finding 71: a deps key miss rebuilt without inode headroom"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 71: a deps key miss rebuilt without inode headroom

## Symptom

A deps-key miss on the box worker runs `build-deps.sh`, which `pnpm install`s and `mv`s every `node_modules` tree into `/opt/hobo-deps` inside a BuildKit overlay. That overlay can consume hundreds of thousands of inodes and several gigabytes on Docker's data root. Admission already reserves inode growth for jobs, but the background rebuild does not go through admission, so a miss could exhaust the box and red a concurrent Main full gate with `ENOSPC`.

## Cause

`build-deps.sh` pruned BuildKit only after a successful reuse or after the new image was built and verified. The install/mv stage ran first. `docker image prune -af` is forbidden: it would delete `hobo-ci-deps:local` and in-use job images.

## Fix

Before `docker build`, `build-deps.sh` samples free inodes and bytes on `docker info`'s `DockerRootDir`. Defaults are **400000** free inodes (`HOBO_CI_DEPS_BUILD_INODE_HEADROOM`) and **8 GiB** free bytes (`HOBO_CI_DEPS_BUILD_BYTE_HEADROOM`). Values must be digits only. A shortage runs `docker builder prune -f --keep-storage "$cap"` once and samples again. Still short refuses the rebuild (exit 1) so the daemon's fail-open ensure loop retries later. The deps job is not on Main full gate's critical path. Never `docker image prune -af`.

## Verification

`scripts/test/ci-deps-image-contract.test.ts` asserts the headroom sample, the builder-only prune, the refuse text, the call site before `"${build_command[@]}"`, and the absence of `docker image prune -a`. This sandbox has no Docker daemon, so live `df` recovery was not exercised.
