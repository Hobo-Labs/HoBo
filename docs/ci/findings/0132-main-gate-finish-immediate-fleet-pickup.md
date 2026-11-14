---
type: CI Performance Finding
title: "Finding 132: main gate finish immediate fleet pickup"
description: "Run 43176491360 start lag for Main full gate (finish) was about 2m02s after the last workspace shard completed versus about 10s historically."
tags: [hobo, ci, performance, main-gate, fleet, admission]
---

# Finding 132: main gate finish immediate fleet pickup

## Evidence (before)

Main Fabric run [43176491360](https://github.com/Hobo-Labs/HoBo/actions/runs/43176491360) on `f2bd06ddf`:

- Last **Main workspace test shard** completed → **Main full gate (finish)** started ~**2m02s** later (regression vs ~10s on earlier greens).

## Cause

After shards release trunk capacity, **finish** often hits **memory-headroom** on a saturated box. Cooperative fleet defer treated it like a long-running shard: **45s** (or **5s** with peers) before ARC/mesh could absorb, even though finish is a short gitleaks/checkout leg.

## Fix

- Include **Main full gate (finish)** in **immediate fleet pickup** on **memory-headroom** (same path as plan/deps).
- Name the job explicitly in fabric trunk phase **4** (after workspace shards).

## Measure (expected after)

- Finish **start** within **~15s** of the last shard completing when `peerAbsorbSlots > 0`, or faster local admit when headroom returns.

## Verification

- **TypeScript:** `trunk-fleet-defer.test.ts`, `packages/ci-gh-actions` build.
- **Protobuf / CUE / PACT:** not applicable.
