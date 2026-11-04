---
type: CI Performance Finding
title: "Finding 39: the first deps image made checkout's work directory root-owned"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 39: the first deps image made checkout's work directory root-owned

At **15:06:56Z**, main push run **41853973126** promoted `hobo-ci-deps:local` for the first time (#1712). Every subsequently launched isolated-worker job failed in `actions/checkout` when `git init` could not write `.git`; PR run **41856608057** lost all six jobs. Merge-group run **41853511063** at **15:01Z** was the last good run before promotion.

The final deps stage copied into `/opt/actions-runner/_hobo_work/HoBo/HoBo`, but the worker base image had never created that path. BuildKit created the missing destination and parent directories root-owned; `COPY --chown=1000:1000` covered copied files, not those directories. A warm container without a host work mount exposed that image path directly, so its uid-1000 runner could neither replace the shipped repository contents nor initialize `.git`. The final stage now creates `_hobo_work`, `HoBo`, and `HoBo/HoBo` with owner and group 1000 before the copy, then returns to uid/gid 1000.

Selection also fails closed. Before using an otherwise matching deps image, the daemon runs a network-disabled probe as 1000:1000 once per image id, checking writability of the work root, repository, and shipped `.git`. A failed or unavailable probe emits `hobo_ci_deps_image_fallback` with `reason=unwritable-workdir` and selects the plain worker image. The normal per-lease bind mount has a second, independent consequence: mounting the empty host job directory over `_hobo_work` hides the image's `.git` and every shipped `node_modules`. Deps selection is therefore disabled whenever that work root is configured, preventing a false exact-key match from skipping install with no dependencies visible. The Dockerfile contract pins directory ownership and ordering; unit tests cover probe success, failure, per-id caching, the Docker CLI probe, and mounted-job fallback.

Immediate operator mitigation is to stop the daemon, remove the bad tag with `docker rmi hobo-ci-deps:local`, and restart; alternatively set `HOBO_CI_DEPS_IMAGE=` (empty) and restart to disable selection and the ensure loop. Redeploy the fixed daemon and rebuild the deps image before re-enabling it.
