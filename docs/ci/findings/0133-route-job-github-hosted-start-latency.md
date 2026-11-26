---
type: CI Performance Finding
title: "Finding 133: route job GitHub-hosted start latency"
description: "Run 43176491360 showed about 1m58s from workflow creation to Route runners starting while the route step itself stays near 15s once a runner is assigned."
tags: [hobo, ci, performance, route, github-hosted]
---

# Finding 133: route job GitHub-hosted start latency

## Evidence (before)

Main Fabric run [43176491360](https://github.com/Hobo-Labs/HoBo/actions/runs/43176491360) on `f2bd06ddf`:

- Workflow created → **Route runners** `started_at`: ~**1m58s** (1:36–1:38 AM CST window reported).
- **Route runners** job wall time once running: ~**15s** (typical).

Downstream jobs cannot receive `needs.route.outputs` until route completes, so this gap bounds every trunk pickup skew for the run.

## Cause

**Route runners** intentionally runs on **GitHub-hosted** `ubuntu-24.04` so tier selection does not wait on the fleet it is choosing. The measured gap is therefore **GitHub Actions queue time** before a hosted runner is assigned, not box admission, fleet defer, or `route-runner.mts` logic (which only executes after the job starts).

Tracked gap: no in-repo lever without breaking the hosted-route invariant or relabeling runners (out of scope).

## Fix

- **Document** the split: optimize box/fleet pickup in separate findings (127–132); treat multi-minute **route start** delays as hosted-runner capacity signals.
- **Ops:** watch org hosted-runner concurrency / queue depth when route `queued_at → started_at` exceeds **30s** on main pushes.

## Measure

Compare GitHub API `created_at` vs `started_at` on **Route runners** across consecutive main Fabric pushes. Target: **&lt;30s** p50 once hosted capacity is healthy (job wall remains ~15s).

## Verification

- **TypeScript / worker:** not applicable (documentation + telemetry only).
- **Protobuf / CUE / PACT:** not applicable.
