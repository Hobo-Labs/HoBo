---
type: CI Performance Finding
title: "Finding 76: scripts/ci and docs rebuilt every release image"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 76: scripts/ci and docs rebuilt every release image

## Symptom

The #1741 merge group **Release contract + affected OCI images** job spent about **228 s** building all six product images serially (hobo-cli 83 s, hobo-mcp 86 s, sdk 27 s, codegen 14 s) after a scripts/ci + docs-only change. The merge group wall exceeded two minutes.

## Cause

Every image's layer key hashed the whole `packages/ci-gh-actions/deploy/ci-runner/` directory, including `README.md`. A docs edit there, or any file under that tree, looked like a toolchain change. The build loop was serial. The job always ran `pnpm install` even when the Fabric deps layer was already linked.

## Fix

Directory layer inputs now skip markdown, tests, `docs/`, and scripts that are not the release-image build recipes. Independent images build in parallel; `hobo-mcp` still waits for `hobo-cli`. The release-contract job reuses `HOBO_CI_DEPS_LAYER` when `deps-layer.mts check --require` passes, instead of a 15 s install.

## Verification

`scripts/test/release-oci-affected.test.ts`: ci-runner README, `scripts/ci/deps-layer.mts`, `scripts/lib/deps-key.mts`, and `scripts/test/*` mark no product images; a ci-runner Dockerfile still marks all of them. This sandbox has no Docker daemon, so live parallel builds were not timed.

`isReleaseOciLayerNoise` widens `RELEASE_BUILD_INPUTS` to `readonly string[]` for `Array.includes` and carries a `SAFETY` comment immediately above that assertion (anti-slop).
