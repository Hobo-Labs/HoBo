---
type: CI Performance Finding
title: "Finding 45: dead containers left 12288 MiB reserved and blocked trunk admission"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 45: dead containers left 12288 MiB reserved and blocked trunk admission

On 2026-11-04 the box daemon reported **`inUseMb 12288 of 13954`** while **no job containers were running**. Two stale heavy leases therefore continued to consume `2 × 6144 = 12288 MiB`; only 1666 MiB remained, so new work repeatedly logged `hobo_ci_memory_admission_wait` and trunk could not start. The same stale journal state could make SIGTERM drain wait up to 30 minutes for containers that no longer existed.

Per-lease reconciliation could not clear these leases reliably. `docker inspect` failures, including a missing container, were deliberately treated as ambiguous and retained the lease; an exited container in a pre-running state also had no settlement path. Admission summed the active/reserved lease journal, while drain counted in-flight journal states rather than containers actually alive. Crashes, daemon restarts, externally stopped containers and failures after reservation could therefore leave permanent memory and slot reservations. The reverse case also leaked host resources: a worker-labelled container without a lease had no reconciliation owner.

The daemon now performs one strictly parsed `docker ps -a --no-trunc --filter label=hobo.ci/isolated=1 --format json` inventory reconciliation at startup, before every admission tick, at drain start and on every drain poll. Running/starting/paused containers are never reaped. Exited/dead containers settle through the existing job-completion and runner-exit semantics. Missing containers release after a two-minute grace from the lease timestamp so a reserve-to-create window cannot be reaped; drain bypasses that grace only after the in-flight tick finishes. Every release emits `hobo_ci_lease_orphan_released` with lease/job/run identity, state, reason, age and memory. Unleased worker containers are stopped when necessary and removed. A listing error or timeout releases and removes nothing, because unknown is not gone. `hobo_ci_memory_without_containers` exposes future journal/Docker accounting mismatches.

Admission now reads only leases surviving the same tick's reconciliation. Drain releases missing-container leases immediately and completes when no lease has a live container; the 30-minute bound remains only for genuinely running work (or conservative waits while Docker inventory is unavailable). Regression coverage uses fake Docker and an injected clock for stale-memory admission, running leases, reservation grace, exited containers, listing failure, reverse orphans and both drain outcomes. A real SQLite close/reopen test also proves that a journal full of stale leases is requeued and releases its reservations on the first reconciliation.
