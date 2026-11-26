---
type: CI Performance Finding
title: "Finding 60: the deps key rebuilt on recipe churn"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 60: the deps key rebuilt on recipe churn

## Evidence

Main run **41925357215** at **91a1dd0f** rebuilt the deps image after #1721. **CI deps layer (pnpm)** ran from **22:27:20 to 22:31:34**. **Build deps image** ran from **22:27:27 to 22:29:31**, taking **124 s**: `pnpm fetch` took **17.4 s** uncached, install took **37.7 s**, a further step took **18.2 s**, layer export took **15.2 s**, and offline verification took about **18 s**. The blocking GHCR push started at **22:29:33** and took about **119 s**.

The only deps-related change in #1721 was `scripts/ci/deps-layer.mts`. That script links and checks the payload in a job checkout; it does not determine what the deps image contains.

## Cause

The deps key included the job-side link/check script in `DEPS_BUILD_RECIPE_PATHS`. The script was also copied into the Docker build context, so editing it invalidated the `COPY . .` layer before `pnpm fetch` as well as changing the image key. Node and pnpm entries from `mise.lock` were hashed separately even though `ciRunnerImageVersion`, the toolchain prefix of the deps key, already covers all of `mise.lock`.

## Fix

The deps key now covers the lockfile, workspace file, normalized importer dependency fields, optional npm and pnpm configuration, patches, platform, toolchain version, and an explicit `DEPS_LAYOUT.version`. The Dockerfile, deps build script, and bucket generator have a pinned recipe digest for review, but their contents no longer change the key. A recipe edit that changes image contents or paths requires a layout-version bump; other recipe edits update only the digest.

`scripts/ci/deps-layer.mts` is no longer in the key or Docker build context. The offline verification copies the staged context to a separate temporary directory and adds the link/check script there before streaming it into the candidate container. The bucket generator remains in the build context because the install stage runs it.

## Verification

The key tests mutate every retained input and verify that layout recipes, the link/check script, and Node or pnpm mise entries do not change the key. They also verify the staged context contents and pin the layout recipe digest with the bump-or-update rule. The image contract test pins separate verification staging.

No Docker daemon was available in this environment. Box timings and cache behavior therefore come from the next main run.
