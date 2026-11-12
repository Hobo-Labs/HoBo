---
type: CI Performance Finding
title: "Finding 122: CPU admission load double-count"
description: "Trunk cpu-contention waits subtracted a 4-CPU reservation per running standard container on top of load average that already included those containers (run 43149809357, load 1.6 on 8 CPUs)."
tags: [hobo, ci, performance, cpu, admission, main-gate, shards]
---

# Finding 122: CPU admission load double-count

## Evidence

Main run [43149809357](https://github.com/Hobo-Labs/HoBo/actions/runs/43149809357) on `9769dae88`: **Main workspace test shard 3** waited ~6 minutes on `cpu-contention` with no fleet defer slot while host load1 was **~1.6 on 8 CPUs**. Shard 2 on run `43146211730` likely waited ~13 minutes for the same false-negative headroom (worker `fd0bc91ae`, CPU admission from #1914).

## Cause

`hostCpuHeadroomCpus` computed `cores - load1 - (heavyLeases × 4) - volatility`. **load1** already reflects CPUs used by running 4 GiB trunk containers; multiplying **every** admitted standard lease by 4 reserved CPUs again made headroom negative on lightly loaded eight-core hosts.

## Fix

- Treat **running** leases as accounted in **load1** (`cpuRunningTrunkJobs` in wait logs).
- Reserve CPUs only for **launching** standard+ containers (`creating` / `registered`); **memory-only `reserved` holds without a sandbox reserve 0 CPUs** so queued main shards do not deadlock each other.
- Headroom: `cores - load1 - pendingLaunchReserve - volatility`; admit when `cpuHeadroom >= request`.

## Verification

`host-resource-pressure.test.ts` and `memory-admission.test.ts` — eight cores, load 1.6, two to three running standards admit the next main-trunk shard.
