---
type: CI Performance Finding
title: "Finding 35: neither deps-image producer could promote the layer jobs needed"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 35: neither deps-image producer could promote the layer jobs needed

The box had never had `hobo-ci-deps:local`, so every job container logged `hobo_ci_deps_image_fallback` with `message=missing` and PR impact gate paid about **20 s** in `pnpm install`. The workflow producer skipped all of the last 40 main pushes because their commit file lists had no deps input, and its nightly schedule had not fired since **2026-07-27**. The daemon runs with cwd `packages/ci-gh-actions`, so `depsRoot = process.cwd()` made `depsKeyForRoot` read `packages/ci-gh-actions/pnpm-lock.yaml`, which does not exist; the lockfile is at the repo root. The ensure loop therefore could never compute a key or build the image. `defaultDepsRoot(import.meta.url)` now resolves the repo root. Both the daemon and `build-deps.sh` also required the checkout-computed toolchain even when jobs were actually running the different version tagged `hobo-ci-worker:local`.

PR run job **126567490837** proved the build itself was healthy: it built and verified `hobo-ci-deps:ve9efb8bcd14c-51187f68d736cd6f` in about **2 minutes** inside a job container. PR behavior then removed the unpromoted candidate as designed, so that success could not cure the box.

Every main push now runs `CI deps layer (pnpm)`. Its first post-key step compares the local image's `hobo.ci.deps-key` label and skips resolution, promotion, build, and push on an exact match, making a no-op push cost checkout plus one inspect. The daemon derives its default checkout from `import.meta.url`, emits `hobo_ci_deps_image_ensure_started` with the selected key, and resolves the toolchain exactly as the build does: use the computed worker tag when present, otherwise use the `v[0-9a-f]{12}` tag on `hobo-ci-worker:local`. `deps-key.mts --toolchain` makes that selected version part of both the daemon lookup key and the built image key. PR build-only cleanup, merge-group exclusion, and gate independence are unchanged.

Expected effect: the next main push or daemon poll pulls or builds and promotes the missing layer without operator intervention; a cold local build has the observed roughly 2-minute cost. Subsequent no-op pushes do only the fast label check, eligible job containers select the layer, `Check deps layer match` prints `deps layer match`, and `Install dependencies` is skipped, removing the roughly 20-second relinking cost.
