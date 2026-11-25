---
type: CI Performance Finding
title: "Finding 167: PR batches diverted to a cold trunk pool"
description: "When GitHub-hosted runners were saturated, the route job diverted a same-repository pull-request batch of HoBo CI Fabric to the hobo-trunk label. Trunk pods have no shared pnpm store or deps layer, so every job spent its 20-minute limit downloading packages and was cancelled. PR-batch diversion to the trunk label now honors runnerRouting.box.trunkLend, which the committed policy sets to 0."
tags: [hobo, ci, runners, routing, trunk, pnpm]
---

# Finding 167: PR batches diverted to a cold trunk pool

## Measurements

Run 45349257161 of HoBo CI Fabric, for PR #2946:

- The route job found GitHub-hosted runners with no idle capacity and printed `{"tier":"fleet","runner":"hobo-trunk","why":"batch"}`, with the reason "GitHub-hosted runners have no idle capacity".
- 28 jobs went to `hobo-trunk-runner-*` ARC pods. Every one was cancelled at about 20 minutes, during "Install dependencies".
- At the 20-minute mark the install log read `Progress: resolved 2222, reused 0, downloaded 2107, added 670`: no package came from a local store, and fewer than a third were linked.

Trunk pods carry neither the shared pnpm store nor the deps layer that the `hobo` pool and the box use, so `pnpm install` downloads all 2222 packages from the registry. That does not finish inside the 20-minute job limit. Diversion turned a slow hosted queue into 28 guaranteed failures.

## Fix

- `divertSaturatedPrBatch` in `scripts/ci/route-runner.mts` tries the trunk label only when the committed `runnerRouting.box.trunkLend` is `1`. With `0` it goes straight to the `hobo` pool and its Agent37 overflow, then to `ubuntu-24.04`.
- `trunkLend` already meant "lend spare trunk capacity to shared-label jobs" on the box; the route job now reads the same setting, so one switch governs whether pull-request work may run on trunk runners. `.hobo/ci.json` keeps it at `0`.
- Merge-group routing is unchanged: merge groups still route by `hobo-trunk` queue depth and a verified claim.

## Expected effect

A saturated same-repository PR batch waits on `hobo`, `hobo-agent37` or `ubuntu-24.04` instead of starting on trunk pods it cannot finish on. Trunk runners stay free for main and merge-group work.

## Remaining limits

- Trunk pods still have no warm pnpm store. Setting `trunkLend: 1` brings back PR-batch diversion to them and is only safe once they get one.
- When `hobo` and Agent37 are both unavailable, the batch still waits in the saturated hosted queue.
