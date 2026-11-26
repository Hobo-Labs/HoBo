---
type: CI Performance Finding
title: "Finding 119: main trunk fleet pickup and admission"
description: "Run 43142885891 took 17m05s; shard 3 queued ~8m after plan and route→deps / deps→plan gaps were ~2m each."
tags: [hobo, ci, performance, main-gate, fleet, shards, admission]
---

# Finding 119: main trunk fleet pickup and admission

## Evidence (before)

Main Fabric run [43142885891](https://github.com/Hobo-Labs/HoBo/actions/runs/43142885891) on `82f41ee3b` (**17m05s** wall) after #1914/#1915:

| Stage | Notes |
| --- | --- |
| Route runners → CI deps layer | ~**2m** gap (worker pickup / admission) |
| CI deps → Main workspace plan | ~**2m** gap |
| Main workspace test shard 3 | **~8m** queued after plan completed (02:51:59 start vs plan ~02:43:59) |
| Main full gate | **8m15s** job time (critical path) |
| Other shards | 20s–4m19s |

Hard rules for this arm: no run cancel/rerun; no ARC/hosted-runner job edits; standard memory class stays **≥4096 MiB**.

## Cause

1. **Fleet defer window** — With `peerAbsorbSlots > 0`, headroom-blocked trunk jobs still waited the full **45s** `HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS` before cooperative defer/release paths fired; overflow shards could hold the box while ARC/mesh slots stayed idle.
2. **Fabric admission phases** — `CI deps layer (pnpm)` sorted with generic phase-3 demand, so it could lose to full gate / shards on the same push and widen route→deps / deps→plan pickup gaps.
3. **Full gate** — S0 `agent:check --external-workspace-tests` remains the wall-clock pole (~8m); no gate weakened in this arm (split/parallel profile is a follow-up).

## Fix

- **`effectiveTrunkFleetDeferMs`** — When `peerAbsorbSlots > 0`, use **`min(45s, 5s)`** for defer eligibility and trunk-headroom fleet releases (`PEER_PRESENT_TRUNK_HEADROOM_FLEET_DEFER_MS`).
- **Immediate defer** — Local trunk slots full **or** wait reason **`cpu-contention`** with peers available (no 45s wait).
- **Telemetry** — `hobo_ci_trunk_fleet_defer_decision` logs **`deferMs`** and **`shardIndex`**.
- **Admission** — Fabric phases on push/main trunk: plan **0** → deps **1** → full gate **2** → workspace shards **3** (shard index tie-break unchanged). **CI deps** stays generic phase on **`pull_request`** so required PR gates are not queued behind deps builds.

## Measure (expected after)

On the next memory-thin main Fabric push with **`arcFreeSlots ≥ 1`**:

- Shard queue: high-index overflow shards defer/release within **~5s** of headroom/slot-full wait when peers report capacity (vs multi-minute serial box hold).
- Pickup: **CI deps layer** and **Main workspace plan** admit before **Main full gate** on the same run; route→deps / deps→plan gaps shrink when workers are warm.
- Full gate: still profiled separately; target **<3m** run wall needs additional full-gate parallelization.

Telemetry: `hobo_ci_trunk_fleet_defer_decision` (`deferMs`, `shardIndex`), `hobo_ci_trunk_headroom_fleet_defer`, `hobo_ci_trunk_wait`.
