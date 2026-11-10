---
layout: ../../layouts/Docs.astro
title: CI host health
description: "How the HoBo CI box worker watches its own CPU load, memory, disk and inodes, cleans up early, and tells the fleet when to send work elsewhere."
---

# CI host health

Memory and storage admission each answer for one job at one moment. Neither looks at the machine as a whole. A box can be at several times its CPU count in load and nearly out of inodes, and still be the fleet's first choice for the next job. Jobs then get a runner, stall in setup, and die with it.

The box worker now watches its own host and holds one verdict.

## Three states

| State | When (defaults) | What the worker does |
|---|---|---|
| `ok` | Below every threshold | Nothing |
| `pressured` | Load at or above 1.5 per CPU, available memory at or below 15%, or free disk or inodes at or below 15% | If the reason is storage, runs collection as soon as the current tick ends instead of waiting for the next interval |
| `critical` | Load at or above 3 per CPU, available memory at or below 7%, or free disk or inodes at or below 5% | Also reports its own offers unhealthy, so the [fleet](/HoBo/ci/fleet-balancing/) sends new work to another provider |

What is measured:

- **Load** is the one-minute load average divided by the host's logical CPUs.
- **Memory** is available memory over total memory.
- **Storage** is the free fraction of bytes and of inodes, on Docker's data root and on the work root. The worse of the two filesystems counts.

## It does not flap

The state rises only after three consecutive samples worse than the level it holds, and falls only after six better than it. One spike does not condemn the box, and one quiet sample does not clear it. A host that moves between `pressured` and `critical` settles on `pressured` until `critical` is sustained on its own.

Samples are taken at most every ten seconds. A sample that takes longer than two seconds counts as unread and changes nothing, so a stalled disk cannot hold up the worker's dispatch loop.

## What it logs

`hobo_ci_host_health` is written on the first sample, on every change of state, and every five minutes while the state stays `pressured` or `critical`:

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

The values above are an illustration of the record's shape, not a reading from a real box. `reasons` lists the resources at the reported level: `load`, `memory`, `storage-bytes` or `storage-inodes`.

A sample that cannot be read logs `hobo_ci_host_health_sample_failed` and leaves the state as it was.

## What to look for

A job that was given a runner and then failed in **Set up job** with no log, minutes later, lost its runner. When that happens to several jobs at once, compare the time against this record: it shows which resource the box had run out of.

## What it does not do

- **It does not stop admission.** Memory and storage admission still decide whether a job launches on the box.
- **It only moves work that has not been queued.** The unhealthy signal reaches the [route table](/HoBo/ci/route-table/), and no workflow reads that yet.
- **The thresholds are defaults.** They have not been tuned against a particular box.
- **It needs a redeploy.** A box worker built before this change does not sample at all.

## Related

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Route table](/HoBo/ci/route-table/) · [Troubleshooting](/HoBo/troubleshooting/)
