---
type: CI Performance Finding
title: "Finding 61: a worker restart drained jobs before handing off"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 61: a worker restart drained jobs before handing off

## Evidence

Main run 41925357215 at 91a1dd0f took 573 s. The CI deps layer job ended at 22:31:34. The Main full gate started at 22:35:56 and took 32 s. About 4 min 20 s elapsed while the job waited for a slot and the worker drained for its restart.

## Cause

The box isolated-worker daemon was restarted for a deploy. On SIGTERM it stopped admitting jobs and waited for every running job container to exit, up to the 30-minute drain timeout. The service manager did not start the replacement daemon until the old process exited. Durable leases and detached job containers could already survive the daemon and be adopted by its successor, but the shutdown path did not use that handoff.

## Fix

The default `HOBO_CI_WORKER_STOP_MODE=handoff` now stops admission, finishes in-flight polling and launch work, reconciles leases without admitting more jobs, and exits 0 without waiting for running containers. The successor adopts those containers through reconciliation. `HOBO_CI_WORKER_STOP_MODE=drain` retains the previous wait, timeout, logs, and exit codes for host maintenance and decommissioning.

## Verification

Unit tests cover stop-mode parsing, immediate handoff with running work, reconcile failures, and drain completion and timeout. No box restart was performed here. The next deploy restart's `hobo_ci_isolated_worker_handoff` log is the box evidence.
