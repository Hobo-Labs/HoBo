---
type: CI Performance Finding
title: "Finding 72: deps mount verify missed the link script"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 72: deps mount verify missed the link script

## Symptom

Main Fabric **41986099801** at **c59a0a8f** (#1726) built `hobo-ci-deps:vda125e5eb8a2-7426db5492c7cb83`, then **Verify deps image under job mount** failed with `MODULE_NOT_FOUND: scripts/ci/deps-layer.mts`. Main full gate itself was green (~60 s). A first attempt had already died with `ENOSPC` on inodes during `mv` into `/opt/hobo-deps`.

## Cause

#1726 dropped `scripts/ci/deps-layer.mts` from the deps key and from `readDepsContextFiles` / `--stage` so recipe churn would not rebuild the image. Offline verification in `build-deps.sh` copies the script into a sidecar directory. Mount verify does not: `scripts/test/ci-deps-image-mount.test.ts` tars only the staged context, then runs `node scripts/ci/deps-layer.mts link`. After a rebuild the archive has no link script, so promotion of `hobo-ci-deps:local` never runs.

`deps-layer.mts` imports only Node builtins for `link`. `check` reads `HOBO_CI_DEPS_EXPECTED_KEY` when the mount contract sets it, so it does not need `scripts/lib/deps-key.mts` in the archive.

## Fix

`depsContextPaths` / `readDepsContextFiles` now stage `scripts/ci/deps-layer.mts` next to the bucket generator. The deps key still does not hash that file (finding 60). Mount verify's tar therefore contains `link`. Offline verification's extra copy is unchanged.

## Verification

`scripts/test/deps-key.test.ts` asserts the staged context includes both scripts and that editing the link script still does not change the key. `node --test scripts/test/deps-key.test.ts` and `scripts/test/ci-deps-image-contract.test.ts`. This sandbox has no Docker daemon, so the live mount lane was not re-run.

Once this lands, the next main Fabric can verify the already-built keyed candidate (key unchanged) and promote `:local`. Finding 71 (#1740) still guards inode headroom before a future rebuild.
