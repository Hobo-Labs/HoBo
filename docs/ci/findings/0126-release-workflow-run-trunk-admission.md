---
type: CI Performance Finding
title: "Finding 126: release workflow_run trunk admission"
description: "Main-train release jobs on workflow_run were admitted at PR rank and skipped fleet defer while OCI matrix cells waited under CPU contention."
tags: [hobo, ci, performance, release, workflow_run, admission, fleet-defer]
---

# Finding 126: release workflow_run trunk admission

## Symptom

Release run `43144784243` (`82f41ee3b`) exceeded 35 minutes while
`Build all OCI images on tag (gate publish)` matrix cells (including `hobo-site`
and `hobo-ci-serve`) stayed queued on the box under CPU contention. Fabric main
shards on the same host received cooperative fleet defer; release jobs did not.

## Cause

`admissionRank` and `isMainTrunkFleetDeferJob` only recognized Fabric main-push
job names. HoBo release train runs use GitHub event `workflow_run`, which
admitted at PR rank (`1`) and never matched trunk fleet-defer eligibility even
when jobs were labeled `hobo-trunk`.

## Fix

Treat `workflow_run` like other trunk events for rank and queue ordering.
Recognize main-train release job names for within-run phase ordering and fleet
defer (phases 0–3: gate → contract → OCI build → publish).

## Verification

`packages/ci-gh-actions/test/admission-order.test.ts` — workflow_run rank and
release phase ordering; existing trunk fleet-defer path unchanged for Fabric.
