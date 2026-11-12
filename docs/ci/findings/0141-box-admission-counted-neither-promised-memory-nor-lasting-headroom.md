---
type: CI Performance Finding
title: "Finding 141: box admission counted neither promised memory nor lasting headroom"
description: "Run 43207388098: the box started shard pairs 6 s and 12 s apart against the same free-memory reading on a host with 2.4–4.4 GB free, its CPU pressure gate read a value the kernel always reports as zero, and the route job had no capacity view."
tags: [hobo, ci, performance, admission, memory, cpu, psi, main-gate, shards, fleet]
---

# Finding 141: box admission counted neither promised memory nor lasting headroom

## Evidence

Scheduled main run [43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098) on `fb51fd87d` failed after 48 minutes: shard 0 and shard 6 each lost one test to a Vitest timeout ([finding 140](./0140-main-shard-tsc-codegen-memory-contention.md) hardened the two tests). Other work on the 16 GiB box left about 2.4–4.4 GB free; a 4096 MiB shard is admitted only above 7168 MiB (4096 + 2048 reserve + 1024 volatility).

Job start times on the box's own runners (`hobo-<lease-uuid>`), all queued at 11:22:57Z:

| Shard | Started (UTC) | Result |
| --- | --- | --- |
| 0 | 11:28:34 | failed (60 s test timeout) |
| 7 | 11:47:38 | passed |
| 4 | 11:47:44 | passed |
| 3 | 11:52:23 | passed |
| 6 | 11:52:35 | failed (10 s test timeout) |
| 5 | 11:58:51 | passed |

Shards 1 and 2 and the full gate ran one at a time on ARC (`hobo-runner-*`). The **Route runners** job logged `fleet capacity unset` and sent the run to the fleet.

## Cause

1. **Promised memory was not counted.** The live check compared `MemAvailable − request` with the margin, but a job admitted a moment earlier has not taken its memory yet, so `MemAvailable` still shows it free. Every waiting shard with a slot passed against the same reading, so two 4096 MiB containers could start on as little as 7168 MiB free. The pairs 7+4 and 3+6 fit that pattern; the worker's own log for the run was not read. `memoryAdmitHeadroom` already took a committed amount; admission never passed one.
2. **One reading decided.** With other work on the host moving free memory by gigabytes, a single reading above the line admits a job that then runs with the memory gone again. Shard 0 was the only job the box started in its first 19 minutes and still timed out.
3. **The CPU pressure gate could not fire.** Admission blocked on CPU PSI `full avg10 ≥ 45`. The kernel reports system-wide CPU `full` as zero ("CPU full is undefined at the system level, but has been reported since 5.13, so it is set to zero", [psi.rst](https://docs.kernel.org/accounting/psi.html)); only `some` moves.
4. **The CPU reservation ended as the job began.** A launching standard job held 4 CPUs, released the moment its container ran ([finding 122](./0122-cpu-admission-load-double-count.md)) on the ground that the 1-minute load average now carried it. That average takes about a minute to show a new job, so the next shard passed 6–12 s later.
5. **Routing had no capacity view.** `route-runner.mts` parses `HOBO_CI_FLEET_CAPACITY` as per-label `admit`/`requiredMb` records (`capacity.ts`), but the worker publishes the `version: 1` / `admittedParallel` shape (`capacity-input.ts`). The parse fails, the route job reads "unset", and the fleet is taken to admit. Not fixed here; see below.

The 7168 MiB line itself was checked and left alone: a shard's measured peak is about 2.2 GiB, but [finding 101](./0101-shared-box-memory-stall-on-shard-1.md) recorded stalls on this box after admitting at 4.6–5.9 GiB free.

## Fix

- **Committed memory** (`memory-admission.ts`): the live check subtracts every admitted reservation `MemAvailable` cannot show yet — all of it until the container runs, then a share falling to zero over **`HOBO_CI_WORKER_MEMORY_RAMP_MS`** (default 120000) from the lease's `dispatchingAt`. Applies to job admission and warm reservations. A job never counts its own reservation; the trunk does not count unlaunched general holds, as in the budget check. Waits log `committedMb`.
- **Low-water free memory**: admission reads the lowest `MemAvailable` over **`HOBO_CI_WORKER_MEMORY_LOW_WATER_MS`** (default 60000). Readings from before one of the worker's own leases ended are dropped, so a finished job does not delay the next. `parallelLaunchCapacity` reads the same value.
- **CPU pressure**: admission also blocks on CPU PSI `some avg10 ≥ 50`.
- **CPU lag**: a started standard-or-heavier job keeps `4 × e^(−t/60 s)` CPUs reserved, the share the load average does not show yet (zero after three minutes, so nothing is held twice).

## Not changed

- **Route job capacity** (cause 5) needs the published snapshot to carry a memory verdict; [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935) adds `trunkMemoryAdmit` and edits the same publisher files. Reading it in `route-runner.mts` follows that PR.
- **Stall guard**: `cpu-psi-load` reads the same always-zero CPU `full` value, so it cannot fire. It stops running containers, so its threshold needs the box's PSI history before it is made live.
- Class sizes, reserve and volatility.

## Measure

On the next main run with other work on the box: no two `hobo_ci_memory_admitted` lines for 4096 MiB jobs within the same minute unless `availableMb` covered both (`availableMb − committedMb − 4096 ≥ 3072`); `hobo_ci_memory_admission_wait` shows `reason: memory-headroom` with `committedMb > 0` for the held shard; no Vitest timeouts on shards that ran alone.

## Verified

- `packages/ci-gh-actions/test/memory-admission.test.ts` — *host capacity a shared box really has* (seven cases; five fail on the previous code)
- `packages/ci-gh-actions/test/host-resource-pressure.test.ts` — CPU `some` gate, committed memory, load-average lag, memory ramp
- Not verified on the box: thresholds (`some ≥ 50`, 120 s ramp, 60 s window) are chosen from the kernel's definitions and this run's timings, not from the box's telemetry.
