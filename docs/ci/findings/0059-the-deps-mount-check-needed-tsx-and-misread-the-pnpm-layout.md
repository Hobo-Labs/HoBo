---
type: CI Performance Finding
title: "Finding 59: the deps mount check needed tsx and misread the pnpm layout"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 59: the deps mount check needed tsx and misread the pnpm layout

## Evidence

Main went red at fcafbf02, the merge of the off-workdir deps payload (Finding 39). In run 41917366853, **CI deps layer (pnpm)** failed at **Verify deps image under job mount**: `node --import tsx --test scripts/test/ci-deps-image-mount.test.ts` threw `ERR_MODULE_NOT_FOUND` for `tsx`. The box daemon's ensure step ran the same command and failed the same way, so it never promoted the new image to `hobo-ci-deps:local`.

The jobs that did start logged `deps layer miss: job=vda125e5eb8a2-5ec9bef6e0daa52e, checkout=vda125e5eb8a2-5ec9bef6e0daa52e`, `match=false`. The keys were identical. The worker then logged `hobo_ci_deps_image_fallback` with `reason=unwritable-workdir` and ran on the worker image. That meant a full install per job, which added to inode pressure on a box already at 86%.

## Cause

There were three separate defects.

1. **The verifier depended on what it verifies.** After Finding 39, the checkout has no `node_modules` until the payload is linked in. The deps job and the daemon both run the mount test from that bare checkout, so `--import tsx` cannot resolve. Plain `--experimental-strip-types` cannot load the test either: `storage-admission.ts` imports `./image-gc.js`, a NodeNext specifier for a sibling `.ts` file, and Node does not remap it.
2. **`deps-layer.mts check` compared the wrong things.** It looked for the compact string `"virtualStoreDir":".pnpm"` in `.modules.yaml`. pnpm writes that file pretty-printed (`"virtualStoreDir": ".pnpm"`), so the check never matched a real install. It also required `node_modules/@hobo/ci-gh-actions` at the root, but the root manifest declares no workspace dependency, so pnpm never creates that link. The test fixture encoded both assumptions, which is why it passed. A mismatch also printed no reason, so identical keys looked like a key bug.
3. **The worker probe reported one reason for every failure.** The image it probed was the pre-Finding-39 `:local` (no `/opt/hobo-deps`), because ensure could not promote. It failed `test -r /opt/hobo-deps/...`, but the log said `unwritable-workdir`.

## Fix

- `scripts/lib/ts-source-resolve.mts` is a builtins-only `module.registerHooks` resolve hook. When a relative `.js` import of a file-URL parent is not found and the sibling `.ts` exists, it loads the `.ts` file. The deps job, `build-deps.sh`, and the daemon's `deps-image.ts` now run `node --experimental-strip-types --no-warnings --import ./scripts/lib/ts-source-resolve.mts --test scripts/test/ci-deps-image-mount.test.ts`. No install is needed.
- `storage-admission.ts` no longer imports `zod` at module load, so the mount verifier can load `createNodeWorkerStorageFileSystem` before the deps payload is linked.
- `matches()` accepts `.modules.yaml` with any whitespace around `"virtualStoreDir": ".pnpm"`. It checks the workspace link that pnpm actually creates (`packages/ci-gh-actions/node_modules/@hobo/ci` resolves to `packages/ci`). Every miss now names its cause: `deps layer miss (<reason>): job=…, checkout=…`. The `match=` output line is unchanged.
- The mount test's in-container check uses the same workspace link instead of `node_modules/@hobo/core`.
- The worker probe exits 3 for an unwritable runner directory and 4 for a missing payload or key marker. The fallback log now reports `unwritable-workdir`, `missing-payload`, or `probe-failed`.

## Verification

- `scripts/test/deps-layer.test.ts` now builds a pnpm-shaped fixture: pretty-printed `.modules.yaml` and the package-level `@hobo/ci` link. It fails against the old `matches()` and passes against the new one, and it asserts the `modules-not-linked` and `job-key-mismatch` miss reasons.
- Against a simulated payload: identical keys give `deps layer match` and `match=true`. A wrong job key gives `miss (job-key-mismatch)`. A missing payload gives `miss (payload-key: ENOENT)`.
- With `node_modules` moved out of the checkout, the mount test loads and skips under the new command. Without the hook it fails with the same `ERR_MODULE_NOT_FOUND` CI saw.
- `scripts/test/ci-deps-image-contract.test.ts` pins the new invocation in the job and in `build-deps.sh`, and rejects `--import tsx` there.
- A real deps-image build and mount run need Docker, which this development environment does not have.
