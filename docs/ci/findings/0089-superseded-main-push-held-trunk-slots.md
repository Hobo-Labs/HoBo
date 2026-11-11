---
type: CI Performance Finding
title: "Finding 89: superseded main push held trunk slots"
description: "cancel-in-progress left older main Fabric runs ingesting jobs and winning oldest-first trunk admission until the newer SHA queued for minutes."
tags: [hobo, ci, worker, trunk, main]
---

# Finding 89: superseded main push held trunk slots

## Evidence

Main run [42957672185](https://github.com/Hobo-Labs/HoBo/actions/runs/42957672185) spent ~5 minutes queued while an
older Fabric run was still cancelling after a newer push to `main`.

## Cause

GitHub keeps superseded workflow runs in `in_progress` until every job stops.
The worker still polled their queued jobs and admission ordered trunk pushes
oldest-first, so stale demand consumed slots ahead of the live SHA.

## Mitigation

Admission prefers newer `push` runs among equal trunk rank.
`supersededMainFabricPushRunIds` skips ingesting queued jobs from older
in-flight HoBo CI Fabric `push` runs on `main` (pull requests unchanged).
