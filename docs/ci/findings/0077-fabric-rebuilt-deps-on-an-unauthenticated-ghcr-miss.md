---
type: CI Performance Finding
title: "Finding 77: Fabric rebuilt deps on an unauthenticated GHCR miss"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 77: Fabric rebuilt deps on an unauthenticated GHCR miss

## Symptom

Green Main Fabric run **42022913128** on `7939a63be` took **152 s** wall. The longest arm was **CI deps layer (pnpm)** at **121 s**: checkout and key computation took about 6 s, `hobo-ci-deps:local` had another key, and resolve ran before GHCR login. With `source=build`, the job logged `deps registry cache import skipped: classic image store`, then spent about **109 s** rebuilding and verifying the image on the Fabric wall.

## Cause

Earlier publisher runs were skipped because their Fabric runs failed or were cancelled, so GHCR lacked the key. Publisher **42023247644** succeeded only after this green run. An unauthenticated `docker manifest inspect` could not see a private GHCR package even after a later publish, so resolve-before-login could turn an available keyed cache into a cold rebuild.

## Fix

Fabric now performs read-only GHCR login before resolve, then reuses the exact keyed local tag or an authenticated GHCR manifest/pull hit. A remaining PR miss still builds with `--no-promote`; a non-PR miss succeeds without building, verifying, or promoting and defers to **CI deps image publisher** and the daemon ensure loop. After confirming the GHCR miss, the publisher reuses a local candidate or builds it, pushes the keyed tag, and retains the containerd-gated `mode=min` `buildcache` export. Its timeout is 20 minutes.

## Residual

The first lockfile/key change still pays about **109 s** on the publisher, not Fabric. The box uses the classic image store, so `--cache-from` remains skipped. The mise OCI native rebuild also remains residual, but is already skipped when `mise.toml`, `mise.lock`, and runner inputs are unchanged; `build.sh` already pulls the versioned GHCR worker tag before a native rebuild. On a GHCR hit, the expected Fabric deps-layer wall is a few seconds for login, pull, and tag, not **121 s**.

## Verification

`scripts/test/ci-deps-image-contract.test.ts` pins login-before-resolve, PR-only Fabric builds, non-PR deferral without candidate verification or promotion, publisher build-after-miss ordering, the 20-minute publisher timeout, and stdin-only GHCR tokens.
