---
type: CI Performance Finding
title: "Finding 25: inode exhaustion made PR installs fail with ENOSPC"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 25: inode exhaustion made PR installs fail with ENOSPC

The box reached **95% inode usage**, after which PR installs failed with `ENOSPC` despite disk-space cleanup. Byte-free space alone could not predict that failure. The third incident established the rate: every gate job left a fresh roughly 2,000-package `node_modules` in its per-job work directory, exhausting the box's inodes in about **30 minutes**. Worker admission now samples `statfs` on both Docker's data root and `HOBO_CI_WORKER_WORK_ROOT`, checking `(blocks - bfree) / blocks` and the `df -i` equivalent `(files - ffree) / files`.

Each job now bind-mounts `hobo-<lease-id>` under the work root as its Actions work folder. Container teardown removes that host directory, including `node_modules`, in a `finally` path after pass, failure, cancellation, runner/container crash or timeout. Startup invokes the same dead-work-directory reaper for crash recovery. A directory is eligible only when its lease is no longer active **and** Docker confirms that its container no longer exists. Live job directories, directories with an existing container, symlinks and unrelated directory names are never removed; inspection errors fail closed for that directory. `hobo_ci_work_dir_removed` records bytes and entries removed.

All jobs share the daemon's read-write, content-addressed pnpm store at `/pnpm-store`; jobs may add content but never prune it. `npm_config_package_import_method=hardlink` makes installs link rather than copy packages. Startup refuses a store and work root on different filesystems, because hardlinks cannot cross filesystems. The daemon runs `pnpm store prune` only when no active job holds the conservative whole-job install lease, so a prune cannot race an install.

When either usage on either root exceeds **85%**, and on scheduled GC at least every five minutes (`HOBO_CI_WORKER_GC_MS`, capped at 300000), the daemon removes every unused `hobo-ci-deps-fetch:*` intermediate, keeps only the two newest `hobo-ci-deps:<key>` images plus `hobo-ci-deps:local` and images used by running containers, prunes dangling images, and enforces the BuildKit cap regardless of age. Dead work directories are reaped by the same pass. After pruning, usage above **95%** for either bytes or inodes keeps the job queued. One structured `hobo_ci_inode_pressure` event per pressure episode records the root, usage percentages and whether bytes, inodes or both are above the hard limit. Sampling errors also refuse admission rather than risking another ENOSPC failure. The work root defaults to `${XDG_STATE_HOME:-~/.local/state}/hobo-ci/work`; the Docker root comes from `docker info --format '{{.DockerRootDir}}'`.
