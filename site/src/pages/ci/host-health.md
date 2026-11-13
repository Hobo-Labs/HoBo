---
layout: ../../layouts/Docs.astro
title: CI host health
description: "How the HoBo CI box worker watches its own CPU load, memory, disk and inodes, cleans up early, and tells the fleet when to send work elsewhere."
---

# CI host health

Memory and storage admission each answer for **one job at one moment**. Neither looks at the machine as a whole: a box can be at several times its CPU count in load and nearly out of inodes, and still be the fleet's first choice. Jobs then get a runner, stall in setup, and die with it.

The box worker watches its own host and holds **one verdict**.

## States

| State | When (defaults) | What the worker does |
|---|---|---|
| `ok` | Below every threshold | Nothing |
| `pressured` | Load ≥ 1.5 per CPU, available memory ≤ 15%, or free disk or inodes ≤ 15% | If the reason is storage, runs collection as soon as the current tick ends |
| `critical` | Load ≥ 3 per CPU, available memory ≤ 7%, or free disk or inodes ≤ 5% | Also reports its own offers unhealthy, so the [fleet](/HoBo/ci/fleet-balancing/) sends new work elsewhere |

| Measured | How |
|---|---|
| **Load** | One-minute load average over the host's logical CPUs |
| **Memory** | Available over total |
| **Storage** | Free fraction of bytes and of inodes, on Docker's data root and the work root; the worse filesystem counts |

## It does not flap

- **Up** after three consecutive samples worse than the held level.
- **Down** after six better than it.
- A host that moves between `pressured` and `critical` holds `pressured` until `critical` is sustained on its own.
- Samples are at most ten seconds apart. One slower than two seconds counts as unread, so a stalled disk cannot hold up the dispatch loop.

## What it logs

`hobo_ci_host_health` is written on the first sample, on every change of state, and every five minutes while the state is `pressured` or `critical`.

```json
{
  "event": "hobo_ci_host_health",
  "state": "critical",
  "previous": "pressured",
  "reasons": "storage-inodes",
  "loadPerCpu": 0.82,
  "memoryAvailableFraction": 0.41,
  "storageFreeBytesFraction": 0.37,
  "storageFreeInodesFraction": 0.04
}
```

The record above shows the **shape**; its values are an illustration, not a reading from a real box. `reasons` is one or more of `load`, `memory`, `storage-bytes`, `storage-inodes`. A sample that cannot be read logs `hobo_ci_host_health_sample_failed` and changes nothing.

## What to look for

A job that was given a runner and then failed in **Set up job** with no log, minutes later, lost its runner. When that happens to several jobs at once, compare the time against this record: it names the resource the box had run out of.

## What host health is not

- Not an admission gate: memory and storage admission still decide whether a job launches on the box.
- Not a rescue for queued jobs: critical storage reaches the box relay's [routing slip](/HoBo/ci/route-table/), which only the next run's route job reads.
- Not tuned: the thresholds are defaults, not fitted to a particular box.
- Not retroactive: a box worker built before this change does not sample at all.

## Related

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Route table](/HoBo/ci/route-table/) · [Troubleshooting](/HoBo/troubleshooting/) · [Observability](/HoBo/observability/)
