---
type: CI Performance Finding
title: "Finding 49: the deps image build could not create its payload directory"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 49: the deps image build could not create its payload directory

## Evidence

Run 41888893009 failed in the **CI deps layer (pnpm)** job while building `packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile`. At `#7 15.72`, `mkdir` reported `cannot create directory '/opt/hobo-deps': Permission denied`. Every subsequent `node_modules` move then failed because the destination did not exist, and the install-stage `RUN` exited 1.

No deps image was produced with the new layout, so jobs reported `deps layer miss: job=none` and performed their own installs. In Main full gate run 41895991796, **Install dependencies** took approximately **19 seconds**.

## Cause

The `install` stage inherits `USER 1000:1000` from `fetch`. The fetch stage created the pnpm store and work directory as root, but did not create `/opt/hobo-deps`. Because `/opt` is root-owned, uid 1000 could not create the payload destination or move the dependency trees into it.

The move loop also ran without `set -e`, allowing a failed `mkdir` to be followed by repeated failed moves instead of stopping at the first directory error.

## Fix

The fetch stage's root `RUN` now creates `/opt/hobo-deps` and chowns it to `1000:1000` before switching to uid 1000. The `find ... -exec sh -c` move script now starts with `set -e`, so any failed directory creation or move fails the build immediately.

The Docker-free contract test in `scripts/test/ci-deps-image-contract.test.ts` pins the root-step ordering, ownership, and fail-closed move loop. A local image build was not run because Docker/buildx is unavailable in the development environment.
