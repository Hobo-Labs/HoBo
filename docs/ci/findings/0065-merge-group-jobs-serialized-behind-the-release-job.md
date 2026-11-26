---
type: CI Performance Finding
title: "Finding 65: merge-group jobs serialized behind the release job"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 65: merge-group jobs serialized behind the release job

## Evidence

Steady-state GitHub job timestamps on 2026-11-05 showed that main-push jobs started 12–20 s after run creation: the 15 s job poll, launch, and runner registration. Merge-group landings instead waited 150–210 s before the PR impact gate was picked up, while general `hobo` slots were idle.

| Observation (UTC) | PR impact gate, `hobo-trunk` | Release contract + affected OCI images, `hobo-trunk` | Gate wait before pickup |
|---|---|---|---|
| Run 41945973711, pr-1727 | Created 01:04:35; started 01:07:39; done 01:08:16 | 01:05:01–01:07:32 | 184 s |
| 00:56:52 observation | Started 00:59:52 | 00:57:16–00:59:44 | 180 s from the observed gate creation |
| 00:41, 23:55, 23:51, and 23:20 observations | Same serialization pattern | Same-group release job ran first | 150–210 s across observations |

Each landing took about 220 s wall time, with about 150 s spent waiting for the same merge group's release job.

## Cause

`dispatchPending` applied `HOBO_CI_WORKER_MERGE_GROUP_LEASES` per lease. Two workflows in one merge group have different run ids but the same `head_sha`, so the release job consumed the default capacity of one and the PR impact gate could not lease until release finished.

## Fix

The cap now counts distinct merge groups keyed by the run's `head_sha`. All jobs in an admitted group remain subject to memory, slot, and trunk admission, but do not serialize behind another job in that group. The default remains one distinct group. The admission cache supplies run metadata from reads already made by the poller and relay; no GitHub request was added per job or tick. Missing SHA metadata conservatively falls back to a run-specific group. `hobo_ci_merge_group_cap_wait` now includes `groupKey`.

`HOBO_CI_JOB_POLL_MS` now defaults to 5000 ms, with the existing 5000 ms minimum unchanged. Every poller list read—queued runs, in-progress runs, newest runs, completed runs, and each run's jobs—uses the same cached-ETag path and sends `If-None-Match` when a prior response supplied an ETag. GitHub does not count 304 responses against the primary rate limit.

Each isolated runner registration logs one `hobo_ci_job_pickup` record with `jobId`, `runId`, `runEvent`, `label`, `admittedAt`, `containerStartedAt`, `runnerRegisteredAt`, and stage deltas. When ingestion supplied the job creation time, the record also includes `jobCreatedAt`, `jobCreatedToAdmittedMs`, and total `pickupMs`; unknown metadata is omitted. This adds no GitHub calls.

## Expected effect

The PR impact gate can start with the release job instead of after it, reducing expected wall time from about **220 s to 160 s per landing**. Lowering the poll interval from 15 s to 5 s reduces mean discovery delay from about **7.5 s to 2.5 s**. The pickup records provide box-log measurements for the remaining discovery, admission, container-start, and registration delays.

## Verification

Regression tests prove that two runs with one merge-group SHA lease together under a one-group cap, a different SHA waits, and finishing the first group frees capacity. Tests also pin the 5000 ms poll default and one pickup record per registered lease, including timestamps and deltas. The conditional-read path covers every poller list request.
