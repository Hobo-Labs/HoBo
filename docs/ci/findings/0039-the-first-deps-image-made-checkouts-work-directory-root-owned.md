---
type: CI Performance Finding
title: "Finding 39: the first deps image made checkout's work directory root-owned"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 39: the first deps image made checkout's work directory root-owned

At **15:06:56Z**, main push run **41853973126** promoted `hobo-ci-deps:local` for the first time (#1712). Every subsequently launched isolated-worker job failed in `actions/checkout` when `git init` could not write `.git`; PR run **41856608057** lost all six jobs. Merge-group run **41853511063** at **15:01Z** was the last good run before promotion.

The final deps stage copied into `/opt/actions-runner/_hobo_work/HoBo/HoBo`, but the worker base image had never created that path. BuildKit created the missing destination and parent directories root-owned; `COPY --chown=1000:1000` covered copied files, not those directories. A warm container without a host work mount exposed that image path directly, so its uid-1000 runner could neither replace the shipped repository contents nor initialize `.git`. The per-lease bind mount exposed a second defect: it covered `_hobo_work`, hiding the image's `.git` and every shipped `node_modules`. `Check deps layer match` trusted the image label, skipped install, and later failed because `tsx` was absent.

The operator restored main with an uncommitted hotfix that pre-created `HoBo/HoBo` as uid 1000 and suppressed the deps key on mounted jobs; run **41859249696** passed in **124 s**. The permanent fix keeps the owned-directory preparation but removes the mounted-job limitation. `prepareJobDirectory` creates and chowns the job root, `HoBo`, and `HoBo/HoBo` to 1000. The final image no longer creates or copies into `_hobo_work` and ships no `.git`; instead it mirrors every repo-relative `node_modules` under `/opt/hobo-deps`, owned by 1000, with a deps-key marker.

After checkout, `scripts/ci/deps-layer.mts link` symlinks each payload `node_modules` into the same relative checkout path, preserving pnpm's virtual store and rewriting workspace source links to the checkout. `check` requires matching job, checkout, and payload keys; a linked `.modules.yaml` and virtual store; repaired workspace manifests; root and workspace `tsx` resolution; and successful `pnpm exec tsx --version`. Every failure outputs `match=false`, so the ordinary frozen install runs. Mounted and warm jobs both select the layer. The once-per-image-id daemon probe remains fail-closed for payload readability and runner-directory writability, logging `hobo_ci_deps_image_fallback` with `reason=unwritable-workdir` on failure.

Static contracts pin the off-workdir layout and owned directories. Unit tests cover job preparation, selection, link failures, and module resolution. A required Docker lane prepares a real job directory through the same filesystem port, runs the same link/check script under a uid-1000 bind mount, initializes a git worktree, and verifies root/workspace resolution, workspace and ts-autocode links, and `pnpm exec`; `ci-deps-image` and daemon promotion both require it before tagging `:local`.

Immediate operator mitigation remains: stop the daemon, remove a bad tag with `docker rmi hobo-ci-deps:local`, and restart; alternatively set `HOBO_CI_DEPS_IMAGE=` (empty) and restart to disable selection and the ensure loop.
