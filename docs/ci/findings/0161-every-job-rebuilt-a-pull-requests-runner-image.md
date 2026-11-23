---
type: CI Performance Finding
title: "Finding 161: every job rebuilt a pull request's runner image"
description: "Pull request 2953 changed the runner image's inputs, so GHCR had no worker image for its content key and the cold dev loop built one itself on an ARC pod, timing out after 600 s. The image job now builds the image once per pull request head and shares it through GHCR under a pull-request tag that later jobs pull; the base layers reuse a registry cache that only main writes."
tags: [hobo, ci, performance, arc, runner-image, ghcr, buildkit]
---

# Finding 161: every job rebuilt a pull request's runner image

## Measurements

Run 45260915169 (pull request 2953), job "hobo dev cold loop (offline <=60s)" (137995470677) on ARC pod `hobo-trunk-runner-pwdb2`:

| Time (UTC) | Event |
| --- | --- |
| 21:01:06 | `hobo-ci-worker:local is not on this runner; materializing it from the host cache or GHCR` |
| 21:01:27 | `GHCR manifest absent for ghcr.io/hobo-labs/hobo/hobo-ci-worker:v749d8677addb` |
| 21:01:27 | `hobo-ci-worker:local could not be pulled; building it on this runner` |
| 21:01:56 | `GHCR_TOKEN is unavailable; skipping published runner image pull` |
| 21:02:16–21:05:42 | base image `apt-get` layer, `#12 DONE 161.7s` |
| 21:05:45–21:06:43 | Actions runner download layer, `#10 DONE 58.2s` |
| 21:07:01 | `#16 exporting to image` |
| 21:11:31 | `build.sh failed or timed out (124)`, then `#16 exporting layers 269.8s done` |
| 21:11:31 | `::error` `could not be pulled from GHCR or built here, and there is no sudo` |

The pull request changed the runner image's inputs, so its content key `v749d8677addb` had no image in GHCR. `ensure-ci-worker-image.mts --materialize-only` found none and the job fell back to `build.sh` under the 600 s build budget. The budget ran out before the base image finished exporting, and `mise oci build` had not started. The pod has no `sudo`, so the job could not use the network namespace fallback either.

The "CI runner image (mise oci)" job in the same run built the same content key. Its push step ran only for `github.event_name != 'pull_request'`, so its image stayed on the pod that built it. Every other pod that needed the worker image repeated the build.

## Fixes

- **One build per pull request head, shared through GHCR.** After a successful build on a same-repository pull request, the image job runs `push-ci-runner-image-ghcr.mts --pull-request`. That pushes only `ghcr.io/<repo>/hobo-ci-worker:pr-<number>-<content key>` with the job's own `GITHUB_TOKEN` (`packages: write`). It never moves `:<content key>`, `:latest` or a `release-*` tag, so HoBo CD and main never trust a pull request's build.
- **Consumers pull that exact key.** `materializeCiWorkerImageOnly` tries `:<content key>` first. On a same-repository pull request with no `HOBO_CI_WORKER_IMAGE_REF`, it then tries `pr-<number>-<content key>`. A fork pull request reads neither and keeps the previous fallbacks: the build, or a `sudo` network namespace. A rerun of the image job also finds the shared tag and skips the build.
- **The cold loop waits for the image job.** `dev-cold-loop-gate` now has `needs: [route, ci-runner-image]` with `!cancelled()`, so it starts after the image is in GHCR. It still runs, and falls back as before, when the image job fails.
- **Base layers from main's registry cache.** `build.sh` builds the base image with `BUILDKIT_INLINE_CACHE=1` and, once logged in to GHCR, `--cache-from ghcr.io/<repo>/hobo-ci-runner-base:buildcache`. Only a push to `main` writes that tag. A pull request that changes only `mise.lock` then reuses the `apt-get` and runner-download layers (about 220 s above) instead of running them. A pull request cannot add cache entries that main's build would reuse.

## Remaining limits

- Each `pr-<number>-<content key>` tag stays in the GHCR package; nothing in CI deletes package versions.
- Main still builds its own image for a content key that a pull request already built. Main's image must come from main's tree.
- Exporting layers into an ARC pod's Docker store (270 s above) still costs the same with or without the layer cache.
