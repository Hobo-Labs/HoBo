---
type: CI Performance Finding
title: "Finding 100: inode grant idle reconcile"
description: "Flat per-job inode grants multiplied on a shared device, an idle JIT listener held one grant, and lease reconcile burned GitHub quota."
tags: [hobo, ci, performance, storage, worker, github-api]
---

# Finding 100: inode grant idle reconcile

## Evidence

Run [43002691441](https://github.com/Hobo-Labs/HoBo/actions/runs/43002691441) on `628e23587` (#1875 pickup fixes on `main`; box worker still on pre-#1875 admission at incident time) showed shard queue skew after a single active inode grant:

| Signal | Value (worker log) |
| --- | --- |
| `hobo_ci_inode_reserve_wait` | `freeInodes` 497,710 · `outstandingInodes` 349,905 · `requiredInodes` 350,000 · `activeGrants` 1 |
| Root inode utilization | ~77% (real pressure, not exhaustion) |
| Idle JIT container | `hobo-391f3e18` · `hobo.ci/timeout-ms=3900000` · Listener idle ~12m |
| Lease reconcile | tick up to ~287s |
| GitHub rate limit | ~4,850 → ~3,125 in ~20m |

Queued-to-started gaps (CST): shard 1 ~4:22–4:29 AM; shard 0 still queued ~11m in.

## Cause

1. **Grant math** — admission summed work + docker inode budgets on a shared device and multiplied by `grants.size`, so one grant made the second trunk job look short even with ~500k free inodes.
2. **Idle listener custody** — a registered runner with no active assignment still held the storage grant until lease grace; 65m container timeout delayed forced retirement.
3. **Reconcile API churn** — each custody pass listed in-progress runs and jobs without TTL or conditional GET reuse.

## Fix

- Bin-pack reservations: per-device **max** of roots on shared stores, **sum of committed grants** minus measured consumption, unmeasured class budgets scaled (~0.65), optional docker inode peaks.
- Release grants on isolated settle; 15s grace; idle JIT listener stop after 3m when job is foreign-queued or unassigned.
- Cap `hobo.ci/timeout-ms` at **20 minutes** on create.
- Wrap worker GitHub transport with short TTL read cache + `If-None-Match` (20s) for run job lists and job GETs.

## Measure

On the next two-slot main Fabric push: no `hobo_ci_inode_reserve_wait` with `activeGrants: 1` and healthy `freeInodes`; workspace shard queued→started within one worker tick when sibling job is idle; reconcile tick p95 under 30s; installation rate limit drop under 500 calls per 20m at steady state.

## Proof

- `packages/ci-gh-actions/test/storage-admission.test.ts`
- `packages/ci-gh-actions/test/github-read-cache.test.ts`
- `packages/ci-gh-actions/test/container-timeout.test.ts`
