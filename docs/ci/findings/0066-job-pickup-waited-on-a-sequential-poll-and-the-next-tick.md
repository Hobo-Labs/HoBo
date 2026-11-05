---
type: CI Performance Finding
title: "Finding 66: job pickup waited on a sequential poll and the next tick"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 66: job pickup waited on a sequential poll and the next tick

## Evidence

GitHub API `created_at` to `started_at` timestamps for the first trunk job on steady-state main push runs showed these pickup delays:

| Main push run | First trunk job pickup |
|---|---|
| 41945542788 | 16 s |
| 41946479423 | 11 s |
| 41947986760 | 19 s |
| 41948202693 | 46 s, during a worker restart |

Pickup consists of the wait until the job poll sees the queued job, the poll's own duration, the wait for the next relay tick, and container/runner launch. Sequential run-list and per-run job-list reads lengthened the poll. An accepted delivery then waited for the next two-second relay timer, and a burst could require several ticks because pull mode drained only ten inbox deliveries per tick.

## Fix

The poller now issues the two status-filtered run lists, the newest-runs list, and the completed-runs list concurrently for each connection. It processes the responses in the previous order, preserving admission priming and run-id ordering. Per-run job lists are read with bounded concurrency (eight by default, configurable from 1 through 32 with `jobReadConcurrency`). All reads settle before a rate-limit error is rethrown; ETags learned by completed reads are retained and the poll pauses as before. Job ingestion remains sequential in run-id order because the inbox has one writer.

A poll with at least one accepted delivery now triggers a relay tick immediately instead of waiting for the next interval. The timer and poll-driven trigger share one coalescing entry point: a tick already in flight permits exactly one pending follow-up. Draining still suppresses new work, and failures retain the `hobo_ci_isolated_worker_tick_failed` event. Pull-mode ticks drain up to 50 deliveries, the maximum accepted by `tick()`, instead of 10.

Together, concurrent reads shorten poll duration, tick-on-accept removes the relay-timer wait, and the larger batch prevents queued and in-progress transitions in one poll from being spread across several ticks.

## Follow-up: reserved trunk capacity

In three of the four runs, `Main full gate` started only 6–7 s after `CI deps layer (pnpm)` finished. Both jobs carry `hobo-trunk`, and one trunk slot is reserved, so the gate serialized behind the deps job. That is a separate trunk-capacity/labeling follow-up; this change does not alter slot reservation or job labels.

## Measurement on the box

Each runner registration emits `hobo_ci_job_pickup`. Use `jobId`, `runId`, `runEvent`, and `label` to identify the job, then compare:

- `jobCreatedAt`, `admittedAt`, `containerStartedAt`, and `runnerRegisteredAt` for the stage timeline;
- `jobCreatedToAdmittedMs` for discovery, ingestion, and the relay-tick wait;
- `admittedToContainerStartedMs` for container launch;
- `containerStartedToRunnerRegisteredMs` for runner registration;
- `pickupMs` for the total from job creation to runner registration.

Unknown creation metadata is omitted. Compare these fields on later main pushes with the 11–19 s steady-state baseline above, and inspect `hobo_ci_isolated_worker_jobs_polled` for accepted/waiting counts and rate-limit pauses.

## Verification

Poller tests pin bounded overlapping reads, run-id ingestion order under out-of-order responses, rate-limit settling without unhandled rejections, and concurrency-option validation. Tick-trigger tests pin idle execution, one coalesced follow-up, and error reporting without disabling later triggers.
