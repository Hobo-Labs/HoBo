---
type: CI Performance Finding
title: "Finding 124: admission telemetry memory headroom"
description: "Main-trunk waits logged host-available and fleet defer no-peer-capacity with hoboFreeSlots 0 while MemAvailable blocked a 4096 MiB job (run 43155912430)."
tags: [hobo, ci, admission, telemetry, memory, main-gate, fleet]
---

# Finding 124: admission telemetry memory headroom

## Evidence

Main run [43155912430](https://github.com/Hobo-Labs/HoBo/actions/runs/43155912430) on worker `80d340cac` (`848289c85`): full gate and shards 0–2 queued with `waitReason: host-available`, fleet defer `holdReason: no-peer-capacity`, and `hoboFreeSlots: 0` while no CI containers ran and load was ~1.5 on 8 CPUs. MemAvailable was ~5.1 GiB — below the 7168 MiB required for a 4096 MiB standard job (4096 + 2048 reserve + 1024 volatility).

## Cause

1. Memory admission logged `host-available` when the worker budget still fit but host MemAvailable did not.
2. With `HOBO_CI_FLEET_ROUTES=0`, relay had no fleet snapshot witness, so defer telemetry defaulted `hoboFreeSlots` to zero.

Defer policy and admission thresholds were correct; labels were not.

## Fix

- Log `memory-headroom` with `availableMb` and `requiredMb` when host memory blocks admission.
- Snapshot real local launch slots for relay telemetry with routes off; omit `hoboFreeSlots` from defer JSON when unknown (never synthesize zero).
