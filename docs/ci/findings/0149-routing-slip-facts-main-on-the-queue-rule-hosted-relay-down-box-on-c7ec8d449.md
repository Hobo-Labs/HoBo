---
type: CI Performance Finding
title: "Finding 149: routing slip facts, main on the queue rule, hosted relay down, box on c7ec8d449"
description: "Main runs go to GitHub-hosted because the queue rule refuses the fleet, not because of the hosted relay; the hosted relay answers 503; the box daemon runs c7ec8d449 and takes new code only after one restart; the five routing repository variables are empty. The facts plan 0026 (routing slips, ADR-0181) starts from."
tags: [hobo, ci, routing, relay, fleet, route-runner, routing-slip]
---

# Finding 149: routing slip facts, main on the queue rule, hosted relay down, box on c7ec8d449

The facts
[ADR-0181](../../design/adr/routing-slips.md#adr-0181) start from, each
checked on 2026-11-13. They are stated once, here.

## Findings

1. **Main runs go to GitHub-hosted because of the queue rule.** Push run
   [43354645076](https://github.com/Hobo-Labs/HoBo/actions/runs/43354645076)
   (`fa092c44f`) printed the route notice
   `{"tier":"github","runner":"ubuntu-24.04","relay":"unanswered","why":"it answered 503","refusedBy":"queue"}`
   and the reason "the fleet has 1 waiting, the oldest for 356 s, and in the
   last 60 minutes took up to 307 s to pick a job up; no local box is
   enrolled; the relay gave no verdict (it answered 503); the limits are
   120 s and 4 waiting". The slowest pickup in the hour, 307 s, is over the
   120 s limit (`SLOW_PICKUP_MEMORY_SECONDS` in `scripts/ci/route-runner.mts`),
   so the queue refused the fleet. Every job of that run, the main gate's
   shards included, ran on `ubuntu-24.04`; only `CI deps layer (pnpm)` asked
   for `hobo-trunk`, through `vars.*` directly.
2. **The hosted relay's 503 does not send runs away; it only removes its
   veto.** A non-200 answer is `unanswered` (`route-runner.mts`, `askRelay`),
   and then the queue decides alone. `https://hobo-ci.vercel.app/readyz`
   answers `503 {"ready":false,"reason":"store-unavailable"}` and
   `GET /v1/fleet/verdicts/hobo-labs/hobo` answers 503. Its Vercel project
   lost its GitHub link after #1883.
3. **The box daemon runs `c7ec8d449` (#1883) and takes new code only after it
   is restarted once.** The last recorded redeploy is
   [finding 108](0108-drain-stale-reservation.md). The daemon runs from a
   checkout, has no update path, its jobs run in containers with no host
   access, and its start log `hobo_ci_isolated_worker_started` carries no
   commit. The fleet verdict reporter postdates `c7ec8d449`, so the box does
   not run it. After one restart onto code with plan 0026's self-update
   (3.8), the box keeps itself current.
4. **The five routing repository variables are empty in production.**
   `HOBO_CI_ROUTE`, `HOBO_CI_LOCAL_RUNNER`, `HOBO_CI_ROUTE_MAX_WAIT_SECONDS`,
   `HOBO_CI_ROUTE_MAX_QUEUED` and `HOBO_CI_TRUNK_RUNNER` read empty in the
   route step of run 43354645076, so the code defaults are in force.
   Committing those defaults as `runnerRouting` in `.hobo/ci.json` changes
   nothing at run time. Whether `HOBO_CI_FLEET_ROUTES`, `HOBO_CI_FLEET_STATE`
   or `HOBO_CI_FLEET_CAPACITY` still exist on the repository is unknown: the
   session proxy refuses the variables API (403).
5. **The GitHub App can write git refs, not checks, statuses or variables.**
   Its manifest (`packages/ci-gh-actions/src/onboarding.ts`) holds
   `contents: write`, `actions: write` and `administration: write`. The route
   job's token holds `actions: read` and `contents: read`, and the job runs
   from a sparse checkout with nothing installed.
6. **The slip's read calls work, and no slip exists yet.** Read-only probe
   (`node scripts/ci/routing-slip-probe.mts --repository Hobo-Labs/HoBo`, a
   token with `contents: read`): `GET /git/ref/hobo/routing-slip` answered
   404 ("no routing slip"); `GET /git/ref/heads/main` then
   `GET /git/commits/e7c50e35bb9d9c3e184957c0709e531a10201978` read main's
   head. The write calls (`POST /git/trees`, `POST /git/commits`,
   `PATCH`/`POST /git/refs`) were exercised against a recorded fake only
   (`scripts/test/routing-slip-probe.test.ts`); nothing was written to the
   repository.

## Measured before routing slips

| Measure | Before (2026-11-13) | After |
| --- | --- | --- |
| Slowest fleet pickup in the last hour, at the run above | 307 s (limit 120 s) | recorded when layer 02 lands |
| Main gate jobs on the fleet, run 43354645076 | 0 (all on `ubuntu-24.04`) | recorded when layer 02 lands |
| Pickup p95, main-gate duration, GitHub-hosted minutes per day | not yet computed | recorded with the before figures when layer 02 lands |

## Gates

- `packages/ci-gh-actions/test/routing-slip.test.ts`,
  `packages/ci-gh-actions/test/runner-routing.test.ts`
- `scripts/test/runner-routing.test.ts` (M4, M8, reader agreement),
  `scripts/test/routing-slip-probe.test.ts` (Git Data API calls)
