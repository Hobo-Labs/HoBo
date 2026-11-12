---
type: CI Performance Finding
title: "Finding 136: trunk hosted overflow no peer"
description: "Main workspace shards stayed on hobo-trunk for 8+ minutes under memory headroom while ARC reported 0 free slots and GitHub-hosted never took the work."
tags: [hobo, ci, performance, main-gate, memory, fleet, overflow, github-hosted]
---

# Finding 136: trunk hosted overflow no peer

## Evidence

Main Fabric run [43183884926](https://github.com/Hobo-Labs/HoBo/actions/runs/43183884926) on `38d4b73eb` trended past **20 minutes**. After a **6m43s** **Main workspace plan**, shards **0–2** remained **queued ~8 minutes** on `hobo-trunk` while the box correctly refused **4096 MiB** class work (**~2.4–5 GiB** MemAvailable vs **7168 MiB** need). Mesh/`HOBO_CI_FLEET_CAPACITY` showed **`arcFreeSlots: 0`**; GitHub-hosted never picked up.

Worker behavior at **`05457ecf3`** and on **`main`**: cooperative trunk fleet defer (`evaluateMainTrunkFleetDefer`) **holds** when `peerAbsorbSlots <= 0`; `createHeadroomTrunkOverflow` existed but was **never called** from `HostedRelay`, and workflows hardcoded `hobo-trunk` instead of reading `HOBO_CI_FLEET_ROUTES`.

## Cause

1. **No hosted escape hatch** — overflow rerun + route publish was implemented but unwired; shards looped on the relay label indefinitely.
2. **Workflows ignored `HOBO_CI_FLEET_ROUTES`** — even a published `trunk` → `ubuntu-24.04` would not affect reruns until jobs read the variable at queue time.
3. **ARC=0 is normal** — fleet defer cannot help without peers; hosted overflow must run after a bounded wait without lowering memory classes.

## Fix

- Wire **`headroomTrunkOverflow`** on the box daemon when **`HOBO_CI_FLEET_ROUTES=1`**; invoke each dispatch pass after cooperative trunk releases.
- **`HOBO_CI_TRUNK_HOSTED_OVERFLOW_MS`** (default **90000**): when memory still blocks and **`peerAbsorbSlots === 0`**, **`publishTrunkHostedOverflow`** then workflow **rerun**.
- Main Fabric trunk jobs use **`fromJSON(vars.HOBO_CI_FLEET_ROUTES…).trunk`** with hobo defaults.

## Measure

On a memory-thin box with **ARC 0**: trunk shards overflow to GitHub-hosted within **~90s** of headroom wait, not **8+ minutes** on `hobo-trunk`; **`hobo_ci_trunk_headroom_overflow`** and **`hobo_ci_fleet_routes_published` `overflow: true`** appear once per rescued run.
