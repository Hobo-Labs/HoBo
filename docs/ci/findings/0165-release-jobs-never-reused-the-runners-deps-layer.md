---
type: CI Performance Finding
title: "Finding 165: release jobs never reused the runner's deps layer"
description: "release-hobo.yml linked HoBo's prebuilt dependency layer only when HOBO_CI_DEPS_LAYER was set, and no release job sets it, so every release job on an ARC pod ran a full pnpm install against the registry and timed out. deps-layer.mts already finds the layer from the payload's key marker; the release jobs now always try it and install only when it does not match."
tags: [hobo, ci, performance, arc, release, deps-layer, pnpm]
---

# Finding 165: release jobs never reused the runner's deps layer

## Measurements

Run 45318508201 (pull request 2974), job "Release Freight realize proof (offline)" (138194875850) on ARC pod `hobo-trunk-runner-7hxkm`:

| Time (UTC) | Event |
| --- | --- |
| 03:32:52 | `self-hosted runner without a shared pnpm store; every package downloads from the registry` |
| 03:32:52 | "Link deps layer or install" skips the layer: `HOBO_CI_DEPS_LAYER` is empty |
| 03:33:27 | `Progress: resolved 2222, reused 0, downloaded 0` |
| 03:33:37–03:47:57 | one to six packages downloaded per second |
| 03:47:57 | `The operation was canceled.` at the 20-minute job limit |

"Release contract + affected OCI images" (138194875935, pod `hobo-trunk-runner-7nknn`) ended the same way at 03:52:52.

The hobo-ci.yml jobs call `scripts/ci/deps-layer.mts link` and `check` without a precondition; the script reads the layer key from `HOBO_CI_DEPS_LAYER` or, when that is unset, from the payload's `.hobo-ci-deps-key` marker. release-hobo.yml wrapped the same two calls in `if [ -n "${HOBO_CI_DEPS_LAYER:-}" ]`, which no release job satisfies, and five other release jobs ran `pnpm install` with no layer attempt at all.

## Fixes

- `.github/workflows/release-hobo.yml`: every "Link deps layer or install" step runs `deps-layer.mts link` and `check --require` unconditionally and installs only when the layer does not match; the five plain `pnpm install` steps use the same step.
- `scripts/ci/attested-jobs.json` mirrors the release-contract step, and `SHADOW_PLAN_BLOB` in `scripts/ci/attestation.mts` follows it.

## Evidence

- `scripts/test/release-sparse-cone.test.ts` checks the unconditional layer attempt and that no release job installs without it.
- `scripts/test/attested-jobs.test.ts`, `scripts/test/attestation.test.ts`, `scripts/test/local-attest.test.ts`.

The node-shared pnpm store (`hobo ci fleet caches --apply`) remains the fix for jobs whose layer key does not match.
