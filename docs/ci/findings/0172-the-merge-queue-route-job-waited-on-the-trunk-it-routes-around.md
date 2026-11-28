---
type: CI Performance Finding
title: "Finding 172: the merge queue route job waited on the trunk it routes around"
description: "On 2026-11-28 nothing merged to main for more than twelve hours: merge-group Route runners and PR impact gate were pinned to hobo-trunk, so with the single trunk slot busy or gone no merge group was ever routed to the hosted fallback."
tags: [hobo, ci, merge-queue, runner-routing, capacity]
---

# Finding 172: the merge queue route job waited on the trunk it routes around

## Baseline

On 2026-11-28 the last commit to reach `main` landed at 05:06 UTC (Hobo-Labs/HoBo#3329). For more than twelve hours after that, every merge group of Hobo-Labs/HoBo#3327 was dequeued with `CI_TIMEOUT`, nine times, while the pull request's own checks were green and it had no conflicts. Other queued pull requests fared the same.

Merge-group runs of HoBo CI Fabric asked for `hobo-trunk` three ways:

- **Route runners** and **PR impact gate** had `runs-on: ${{ github.event_name == 'merge_group' && 'hobo-trunk' || 'ubuntu-24.04' }}` ([#3135](https://github.com/Hobo-Labs/HoBo/pull/3135)).
- A `trusted-route` step pinned the merge group's route to `fleet`, so `route-runner.mts` never ran its merge-group probe, which falls back to `ubuntu-24.04` when the trunk shows no healthy pickup.
- **Scripts tests** asked for `agent37` on every merge group.

The box serves one trunk slot (`runnerRouting.box.trunkSlots: 1`, a 16 GiB host, [finding 101](0101-shared-box-memory-stall-on-shard-1.md)), and its routing slip had last been written on 2026-11-15. One run's Route runners job waited for `hobo-trunk` from 10:12 to past 11:06 UTC without starting. Runs whose route did start then queued their shards one at a time behind that slot (shards started at 06:45, 06:55 and 07:05 UTC in one run) and ran out the merge queue's check timeout.

## Change

- Route runners and PR impact gate run on `ubuntu-24.04` for every event; `scripts/lint-actions.ts` no longer accepts the merge-group trunk expression for them.
- The merge group's route step is `auto`, and the `trusted-route` pin step is gone. `hobo-trunk` stays the first choice: a healthy trunk with positive pickup evidence takes the group without a Broker claim, as the `hobo-ci.yml` fleet pin already allowed. Otherwise the group runs on `ubuntu-24.04`.
- Scripts tests ask for `agent37` on a merge group only when the route chose the fleet; when it chose GitHub-hosted runners, they follow it.
- The Agent37 pool may grow to eight 4 GB boxes (`maxBoxes` and `runnerRouting.externalPools[].maxRunners` 4 → 8), the provider's free-tier ceiling for that size.

## Verification

The scripts tests for the route job, lint-actions, the Scripts tests lane, the main gate and Agent37 capacity pass locally. A merge-group run takes its routing script from the trusted base commit; until this change is on `main`, that base still requires a claim and sends the group to `ubuntu-24.04`, which is the intended backup. Record the first merge-group run after landing, with its runner choice, as the replay against this baseline.
