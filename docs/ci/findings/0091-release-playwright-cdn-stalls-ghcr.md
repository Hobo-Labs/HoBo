---
type: CI Performance Finding
title: "Finding 91: release playwright CDN stalls GHCR"
description: "Release GHCR and deps publisher rebuilds hung on cdn.playwright.dev headless-shell downloads."
tags: [hobo, ci, performance, release, playwright, ghcr]
---

# Finding 91: release playwright CDN stalls GHCR

**Source:** release run `42969407577` (tag `0.0.0-alpha.94`), job `130359420822` (~06:15–06:33 UTC); deps publisher `42969406989`

## Symptom

`Publish GHCR images (tagged release)` spent **~15 minutes** in **Ensure digest-pinned content-keyed toolchain image** and hit the **20-minute** job limit. Logs show Docker layer `[6/7]` curling `cdn.playwright.dev` with repeated `Connection reset by peer` (~130s apart). The deps image publisher failed on the **same** Dockerfile layer.

## Cause

`ensure-ci-worker-image.mts` fell back to `build.sh`, which rebuilds the runner base and downloads the pinned Chromium zip from Playwright's CDN on every miss. Release jobs should **pull** the content-keyed `ghcr.io/.../hobo-ci-worker` image instead.

## Fix

- **Release path:** refuse `build.sh` when `HOBO_RELEASE_VERSION` or tag ref is set; GHCR login + bounded `docker pull` (manifest probe first).
- **Browser archive:** host cache (`HOBO_CI_PLAYWRIGHT_CACHE`), staged zip in build context, install script with **bounded** curl (connect/per-attempt/max budget) instead of unbounded `--retry 5` in Dockerfile.
- **Non-release builds:** `prepare-playwright-runner-cache.mts` seeds the context; `build.sh` wrapped with `timeout`.

## Regression

- `scripts/test/playwright-headless-shell-archive.test.ts`
- `scripts/test/ensure-ci-worker-image.test.ts`
