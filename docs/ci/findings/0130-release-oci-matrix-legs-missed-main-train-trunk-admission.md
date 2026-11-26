---
type: CI Performance Finding
title: "Finding 130: release OCI matrix legs missed main-train trunk admission"
description: "Release run 43176733275 held hobo-ci-serve OCI gate matrix job on the box with not-main-trunk and storage wait while inode use was 74%."
tags: [hobo, ci, release, admission, trunk, storage, matrix]
---

# Finding 130: release OCI matrix legs missed main-train trunk admission

## Evidence (before)

Release run [43176733275](https://github.com/Hobo-Labs/HoBo/actions/runs/43176733275) on `f2bd06ddf` (worker on main including #1920 trunk admission):

| Job | Symptom |
| --- | --- |
| Build all OCI images on tag (gate publish) **(hobo-ci-serve)** | Box hold **>280s**, `holdReason=not-main-trunk`, `waitReason=storage`, inode use **~74%** |

Base job names were covered by `mainTrainReleasePhase`, but GitHub matrix titles append ` (package-id)`; those legs fell through to generic fabric phase **4**, so `isMainTrunkFleetDeferJob` returned **false** and cooperative fleet defer never ran while storage admission blocked on the saturated box.

## Cause

`mainTrainReleasePhase` matched only exact workflow titles, not matrix legs resolved by `lookupByJobName` (already used for storage class maps).

## Fix

- Resolve release phases through `lookupByJobName` + a single phase map (gate, contract, OCI build matrix legs, publish matrix legs).
- Matrix OCI / GHCR legs regain trunk rank, release phase ordering, and main-trunk fleet defer eligibility.

## Measure (expected after)

On the next tagged release with tight box inodes:

- `hobo_ci_trunk_fleet_defer_decision` for `Build all OCI images on tag (gate publish) (*)` shows `isMainTrunkJob=true` and defers to ARC/mesh when storage blocks, instead of `not-main-trunk` + multi-minute box hold.

## Verification

- **TypeScript:** `packages/ci-gh-actions` build + `admission-order.test.ts` (matrix phase + ordering).
- **Protobuf / CUE / PACT:** not applicable (admission ordering only; no contract surface change).
