---
type: Runbook
title: "HoBo.CD runbook: Service host and read API"
description: "The tick loop, health, readiness and /v1/cd/. Assembled from the Runbook section of packages/cd/src/service/README.md."
tags: [hobo, cd, runbook, service]
---

# HoBo.CD runbook: Service host and read API

The tick loop, health, readiness and /v1/cd/. This page is assembled from the **Runbook** section of `packages/cd/src/service/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **`/v1/cd/ready` is 503 with `store`.** The journal probe failed; no module
  step runs until it recovers, and readiness returns by itself on the next
  successful probe. Check the SQLite file / Postgres connectivity (pool,
  statement timeout). Agents keep their leases until TTL and resume by
  observation.
- **503 with `reconciler:<id>` / `reconciler-crashed`.** A run loop exited; the
  host restarts it with backoff (≤ 30 s). If it keeps crashing, read the detail
  (lease refusal, store error, realizer error) and follow the reconcile
  runbook. `hobo.cd.service.reconciler_restarts` climbs while this happens.
- **503 with `step:sources`.** Discovery failed (registry/Git host
  unreachable or credentials wrong). Promotions of existing Freight still run;
  new Freight waits. See the sources runbook.
- **`step:<other>` failing but ready.** Only store, leases and sources gate
  readiness; other steps retry every tick. A step reported as exceeding its
  deadline is skipped until its earlier call settles — look for a hung
  provider call in that module.
- **Drain reports `drain-deadline-exceeded`.** A reconciler or the in-flight
  tick did not stop in time; the process can exit anyway. Its leases expire
  after 30 s and another holder resumes by observation (no double writes: the
  fence refuses the old holder).
- **Retention never runs.** It runs on the first tick and then at most once per
  `retentionIntervalMs` (1 h); check `step:retention` and
  `hobo.cd.service.retention_retired`.
- **SSE clients see repeated or missing facts.** They must resume with the last
  `id:` they received as `Last-Event-ID`; `event: end` after 55 s is expected.
  A malformed id is refused with `last-event-id-invalid`.
- **A read route returns `view-failed`.** A module projection threw; the
  `subject` names the route. Check that module's runbook; the service log has
  the stack.
