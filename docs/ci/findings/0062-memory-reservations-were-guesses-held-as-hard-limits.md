---
type: CI Performance Finding
title: "Finding 62: memory reservations were guesses held as hard limits"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 62: memory reservations were guesses held as hard limits

## Evidence

The worker's memory budget is 13954 MiB after the host reserve. The idle trunk reservation holds 6144 MiB, leaving a PR share of 7810 MiB. Class-sized admission therefore permits one heavy PR job, or one standard and one light PR job. PR runs waited 40–70 minutes for slots.

For example, PR #1720 run 41924222184 attempt 2 created its jobs at 22:37. They started between 22:37:44 and 22:57:49, while each job ran for only 7–34 seconds. The operator also observed about 6.5 GB of `MemAvailable` while 27 jobs waited. The prewarm spare is disabled whenever a work root is set, and production always sets one, so warm memory does not explain the delay.

Reservations were assigned from job-name classes without measuring job-container peaks. Some classes also include work that runs in dockerd or BuildKit rather than in the job container's cgroup. **CI runner image (mise oci)** is heavy and **CI deps layer (pnpm)** is standard, but their principal build memory is outside that cgroup.

## Cause

The lease's `memoryMb` served two purposes: admission accounting and the container's hard Docker memory limit. This made every conservative class guess consume admission capacity for the lease's entire lifetime. Reducing a guess directly would also reduce the hard limit and could turn normal variance into an OOM kill. There was no per-job-name peak history with which to separate safe admission accounting from the limit.

## Fix

Settlement now reads a running container's cgroup v2 `memory.peak`, with a cgroup v1 fallback, before stopping it. A valid sample logs `hobo_ci_container_memory_peak` and is added to that job name's last-20 history in `memory-peaks.json` under the worker work root. Missing or corrupt history starts empty, and measurement failure does not block settlement.

Before three samples, admission now reserves 1024 MiB for light jobs, 2048 MiB for standard jobs, and 4096 MiB for heavy jobs. `HOBO_CI_WORKER_MEMORY_LIGHT_RESERVE_MB`, `HOBO_CI_WORKER_MEMORY_STANDARD_RESERVE_MB`, and `HOBO_CI_WORKER_MEMORY_HEAVY_RESERVE_MB` override these values within their class limits. After three samples, admission reserves the maximum peak multiplied by 1.25 plus 256 MiB, rounded up to 256 MiB and clamped between 1024 MiB and the class size. An OOM clears the job name's samples and forces class sizing for seven days.

The lease stores the reservation, while Docker retains the class-sized `--memory` and `--memory-swap` hard limit. Warm-container matching also uses the class limit. The idle trunk reservation uses the heavy unmeasured default before learning from **Main full gate**, then refreshes from current history on each admission. Every job and warm admission also samples `MemAvailable` and requires the request to leave the configured host reserve. Missing host data falls back to the budget check; a live-host block logs `reason=host-available` with `availableMb`.

With a 4096 MiB idle trunk reservation, the PR share of the 13954 MiB budget is about 9858 MiB. This permits up to nine light, four standard, or two heavy unmeasured PR reservations, still bounded by worker slots and the live host guard. `HOBO_CI_WORKER_MEMORY_LEARN=0` restores full class reservations for everything without lowering hard limits.

## Verification

Unit tests cover unmeasured defaults and override validation, reservation rounding and clamps, recent and expired OOMs, persistence and corruption recovery, the 20-sample cap, cgroup and `/proc/meminfo` parsing, settlement ordering and failure handling, OOM history reset, class-sized Docker limits, concurrent learned admissions, dynamic trunk reservations, live host and warm guards, missing host data, and the rollback switch.

The first box measurements will arrive as `hobo_ci_container_memory_peak` logs. Unmeasured jobs use the per-class defaults immediately after deployment and switch to learned reservations when each job name has three samples.
