---
type: CI Performance Finding
title: "Finding 172: Merge-group Scripts tests queued on agent37 before the fourth box existed"
description: "Merge-group Fabric runs four Scripts tests shards on the agent37 label. The owner-box controller scaled from hobo and hobo-trunk queue depth only, so the fourth shard waited minutes for a cold fourth VM while council work saturated shared boxes."
tags: [hobo, ci, runners, agent37, merge-group]
---

# Finding 172: Merge-group Scripts tests queued on agent37 before the fourth box existed

HoBo CI Fabric merge-group **Scripts tests** shards ask GitHub for the custom
`agent37` label (four shards since finding 166). The live
`agent37-runner-controller.sh` on the owner box scaled demand from `hobo` and
`hobo-trunk` queue depth only, so it did not pre-provision a fourth Agent37 VM
when four `agent37` jobs appeared at once. Council and worker load on boxes that
also register CI runners (one slot per box since Nov 27) further reduced idle
capacity.

## Evidence

Merge-group HoBo CI Fabric run
[46085425374](https://github.com/Hobo-Labs/HoBo/actions/runs/46085425374)
(`#3192`, created `2026-11-27T23:59:09Z`):

| Job | `startedAt` | Queue after run start |
| --- | --- | --- |
| Scripts tests (1) | `00:02:47Z` | ~3m38s (after PR impact plan) |
| Scripts tests (2) | `00:03:18Z` | ~4m09s |
| Scripts tests (3) | `00:03:50Z` | ~4m41s |
| Scripts tests (0) | `00:06:21Z` | ~7m12s |

Shards (1–3) ran on `a37-wshm0nr2f0-*`, `a37-*`, `a37-*`; shard (0) picked up
`a37-0orlh4sgty-1795824004`, a freshly provisioned box. Pickup target is 1–2 s.

## Fix

1. **`scripts/ci/agent37-fleet-demand.mts`** — pure demand accounting:
   `agent37` and `hobo-agent37` queued jobs, merge-group floor of four boxes for
   four script shards, and `RESERVED_IDLE_SLOTS_PER_BOX` (default 1) for council
   coexistence on shared boxes.
2. **`contrib/orchestrator-only/agent37-runner-controller-demand.sh`** — shell
   helpers to merge into `bin/agent37-runner-controller.sh`: count `agent37`
   queue depth, raise `MQ_MIN_BOXES` during merge-group Fabric runs, and refuse
   new council work on a box when `agent37_council_may_use_box` would exceed the
   reserve.

## Gate

`scripts/test/agent37-fleet-demand.test.ts` pins the run-46085425374 shape (three
online boxes, four queued script shards ⇒ create one more box before queue wait
grows).