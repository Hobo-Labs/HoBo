---
type: CI Performance Finding
title: "Finding 115: held jobs survive cancelled runs"
description: "Box worker kept coalesced pending jobs and unlaunched reservations after GitHub cancelled or completed the run."
tags: [hobo, ci, performance, box-worker, poll, admission]
---

# Finding 115: held jobs survive cancelled runs

## Evidence

After `cancel-in-progress` on HoBo CI Fabric, box workers logged `hobo_ci_isolated_worker_jobs_polled` every few seconds with the same **six** jobs from cancelled main runs **`43107920330`** (shards 1–2) and **`43111719541`** (shards 0–3) alongside the live push for **~12 minutes**. Local `pending_jobs` and unlaunched `reserved` leases stayed, eating admission and reservation headroom.

## Cause

Poll ingest **coalesce** and the local store retained quiet jobs even when GitHub had already ended the run or job. The poller read completed runs and terminal jobs but never dropped matching local demand.

## Fix

- Poll summary carries **`heldPruneWitness`** from existing GitHub reads (completed runs, superseded main pushes, completed `hobo` jobs).
- **`createHeldJobPruner`** (30s rate limit) runs after job poll and admission tick: **`withdrawQueuedJob`**, **`pollIngestCoalesce.forget`**, **`clearTrunkWait`**, log **`hobo_ci_held_job_pruned`** with reason. No GitHub cancel, rerun, or ARC/gh-hosted touches.

## Measure

Cancelled or completed runs drop out of `waiting` on the next prune pass; reservations free without worker restart.
