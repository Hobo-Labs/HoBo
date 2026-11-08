---
type: CI Performance Finding
title: "Finding 22: install time is linking, so the job starts from a prebuilt node_modules layer"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 22: install time is linking, so the job starts from a prebuilt node_modules layer

Main run **41762556455** spent **19 s of the 52 s Main full gate** in
`pnpm install --frozen-lockfile --config.confirmModulesPurge=false`. The host-mounted store at `/pnpm-store`
was warm (`HOBO_CI_PNPM_STORE_MOUNTED=1`), so this downloaded nothing: the cost was copying and linking roughly
2,000 packages and 796 workspace importers into `node_modules`. A store-only cache cannot remove that work.

The deps layer builds those trees once per toolchain/deps key and starts eligible HoBo job containers with
them already at `/opt/actions-runner/_hobo_work/HoBo/HoBo`. The key covers every importer manifest, pnpm and
Node versions, platform, patches and config, and the deps Dockerfile/build script themselves. The build's fetch
stage has network access under lockfile integrity pins; installation and native rebuilds run in a separate
network-disabled build. A matching toolchain label selects the layer per lease, and `clean: false` keeps it
through checkout. Main full gate and PR impact gate compare `HOBO_CI_DEPS_LAYER` with the checkout's computed
key: an exact match skips `pnpm install`; every miss runs the ordinary frozen install. The daily scheduled Main
full gate always installs as the ongoing correctness verifier.

Run **41773556225** exposed the first implementation's miss and cleanup costs:

- `CI deps layer (pnpm)` failed after **5m26s**. `RUN pnpm fetch --frozen-lockfile` took **164 s** from an empty
  store, exporting the fetch-stage layers took **84 s**, and copying the install workspace took **21.8 s**.
- The final `find … -prune … -delete` failed because `-delete` enables `-depth`, which makes `-prune` ineffective.
- `PR impact gate` took **4m20s**, including **170 s** in its cold fallback `Install dependencies` step because
  no layer existed. Its checks also found the two readonly `deps-key.mts` assignments, now built immutably.

The fetch and offline install now share the persistent host store through the same BuildKit
`hobo-pnpm-store` cache mount. One multi-stage build performs both phases, with `RUN --network=none` on install,
so no 6–10 GB `hobo-ci-deps-fetch:*` intermediate is tagged. The install stage moves each `node_modules` tree and
the `.git` skeleton to a separate staging directory; the final stage copies only that directory, with no deletion
pass and no fetch store or staged manifests. A new build still must report `Already up to date` from
`pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false` before promotion.

Each keyed `hobo-ci-deps:*` candidate is also 6–10 GB. Building one per lockfile hash without reaping old keys drove
the box to **95% inode use twice**. After a successful build or promotion, the collector keeps at most two keyed
images: the current key and newest previous key by creation time. It never removes `hobo-ci-deps:local`, the current
key, or an image used by a running container; it deletes all unused legacy fetch tags and runs `docker image prune
-f` for dangling layers. The workflow's cache-hit promotion path runs the same collector.

Every event checks the exact local key first, then GHCR, and skips the build on either hit. A local hit only
computes the key, inspects and tags the image. A GHCR-only hit confirms the manifest and materializes the
node_modules-only image once. Existing keyed hits can be promoted on PRs; new PR candidates remain unpromoted
and unpublished. The gate's exact-match path runs only `scripts/ensure-ts-autocode-links.mts`, so its install
step is skipped. Expected local-hit work is a few seconds in the deps job and no install step in the gate; a
GHCR-only hit adds one registry pull but none of the 164 s fetch, 84 s fetch export or full build.

On main pushes, `ci-deps-image` runs only when a deps-key input changed or `ci-runner-image` ran. Missing commit
file lists and forced pushes build fail-safe; schedule and workflow dispatch always run. PR build scoping is
unchanged. Main full gate does not depend on `ci-deps-image`, so an unrelated push neither builds the layer nor
adds a trunk-slot wait.

That event-only producer left the box with **no `hobo-ci-deps:local` image** after #1700 landed: the main push had
no deps input change, so `CI deps layer (pnpm)` skipped and nothing else promoted the image. Every job container
logged `hobo_ci_deps_image_fallback` with `message=missing`, and the fallback `pnpm install` still took **21 s**.
The isolated worker daemon now owns availability independently of workflow filtering. On startup and every five
minutes it reads the head of its default-branch checkout, computes the same content key, and ensures the keyed
local image. A miss tries the GHCR tag first, then builds locally; either path promotes `hobo-ci-deps:local` and
runs keep-2 GC. An unchanged key is a no-op. Builds are single-flight and run outside admission under `nice` and
`ionice`, with Docker memory limits (default 4096 MiB). `hobo_ci_deps_image_ensure` records `hit`, `pull`, or
`build` and elapsed milliseconds; failures emit `hobo_ci_deps_image_ensure_failed` and retry with exponential
backoff without stopping the daemon. Until promotion succeeds, jobs keep the same worker-image fallback.
