---
type: CI Performance Finding
title: "Finding 101: shared box memory stall on shard 1"
description: "Main workspace test shard 1 on a pre-#1876 box worker froze under host memory pressure; Vitest 5s timeouts surfaced ~110s wall."
tags: [hobo, ci, performance, worker, memory, psi]
---

# Finding 101: shared box memory stall on shard 1

## Evidence

Run [43007625951](https://github.com/Hobo-Labs/HoBo/actions/runs/43007625951) on `6905b85b0` (#1876 on `main`; box worker still on `628e23587` at incident time):

| Signal | Value |
| --- | --- |
| Failed job | Main workspace test shard 1 (~4m49s wall); finish gate failed as knock-on |
| Worker job | [130479335214](https://github.com/Hobo-Labs/HoBo/actions/runs/43007625951/job/130479335214) |
| Queue | `queuedToReservedMs` ~69.8s |
| Memory admission wait | ~15s with ~4.6–5.9 GiB `MemAvailable` |
| Container peak | ~2.2 GiB |
| Vitest symptom | three unrelated tests report `Test timed out in 5000ms` with ~110s wall at the same instant |
| Collateral | `@hobo/ci-vercel#test` exit 1 on same push |

Affected tests (same stall window):

- `packages/app/test/neon-secret-broker.test.ts` — accepts an empty streamed body…
- `test/sandbox-proxy-readiness.test.ts` — waits for this launch's marker…
- `test/turbo-ci.test.ts` — refuses Vercel OIDC…

Box at triage: ~16 GiB RAM, ~2.4 GiB available, load ~3.1.

## Cause

1. **Admission looked at MemAvailable only** — a shared box can show several gigabytes free while PSI and swap already indicate scheduling stalls; #1876 inode bin-pack did not widen this gap.
2. **No in-flight stall guard** — once admitted, a container under host memory/CPU starvation kept running until Vitest's per-test timer fired ~110s later, failing `main`.
3. **Metrics mixed host and job** — fleet headroom published MemAvailable without separate PSI/swap telemetry.

## Fix

- Memory admission: `memoryAdmitHeadroom` with `HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB`, plus PSI/swap gates from `/proc/pressure` and meminfo (`host-pressure` reason).
- Running jobs: `createContainerStallGuard` samples during reconcile; on confirmed stall, log `hobo_ci_container_stall_requeue`, stop cooperatively, and `enqueueStall` orphan recovery (5s confirm → force-cancel + `rerun-failed-jobs` on push/pull_request).
- Telemetry: periodic `hobo_ci_host_resource_pressure` (PSI, swap, load) separate from `hobo_ci_memory_admitted` / container peak fields.

## Measure

On the next two-slot main Fabric push on a shared 16 GiB box under foreign load: no Vitest 5s timeouts with ~110s wall without `hobo_ci_container_stall_requeue`; stalled shards recover via rerun without failing finish; admission logs `host-pressure` or `host-available` with volatility when MemAvailable is thin.
