---
type: CI Performance Finding
title: "Finding 149: routing slip facts, main on the queue rule, hosted relay down, box on c7ec8d449"
description: "Main runs go to GitHub-hosted because the queue rule refuses the fleet, not because of the hosted relay; the hosted relay answers 503; the box daemon runs c7ec8d449 and takes new code only after one restart; the five routing repository variables are empty. The facts plan 0026 (routing slips, ADR-0181) starts from."
tags: [hobo, ci, routing, relay, fleet, route-runner, routing-slip]
---

# Finding 149: routing slip facts, main on the queue rule, hosted relay down, box on c7ec8d449

The facts [plan 0026](../../plans/0026-relay-routing-slips.md) and
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
| Slowest fleet pickup in the last hour, at the run above | 307 s (limit 120 s) | the same reading at the first `main` push that a slip routes |
| Main gate jobs on the fleet, run 43354645076 | 0 (all on `ubuntu-24.04`) | the same count at that push |
| Pickup p95, main-gate duration, GitHub-hosted minutes per day | computed by the method below for 2026-11-12 (UTC) | computed by the same method for the first full UTC day on which every route notice says `"slip":"used"` |

The box takes the slip writer only after one restart onto a checkout that has
it (item 3); from then on it keeps itself current. Until that restart the
"After" column has no day to be computed for.

### How the three are measured

All three come from GitHub's REST API for one UTC day, with a token that can
read Actions, and need nothing from the box. GitHub keeps run history for 90
days, so the "Before" day stays computable.

1. **Runs of the day.** `GET /repos/Hobo-Labs/HoBo/actions/runs?created=<day>..<day>&per_page=100`,
   every page; then each run's jobs, `GET /actions/runs/{id}/jobs?filter=all&per_page=100`.
2. **Pickup p95.** Over every job of those runs whose `labels` is exactly one
   of `hobo` or `hobo-trunk` and that has a `runner_name` and a `started_at`:
   the wait is `started_at − created_at` in seconds. Sort the waits and take
   the value at rank `ceil(0.95 × n)`. A job still queued at the end of the
   day counts with `end of day − created_at`. Jobs on `ubuntu-24.04` are not
   pickups of the fleet and are left out.
3. **Main-gate duration.** For each `hobo-ci.yml` run of the day with
   `event: push` and `head_branch: main` whose job `Main full gate (finish)`
   completed: `completed_at` of that job minus the run's `run_started_at`.
   Report the median and the slowest, and the count. A run cancelled by the
   next push is left out (its finish job did not complete).
4. **GitHub-hosted minutes per day.** Exactly CI health's H8 rule
   (`paidMinutes` in `scripts/ci/ci-health.mts`): per job on `ubuntu-24.04`
   with a runner, `ceil((completed_at − started_at) / 60 s)`, summed over the
   day, leaving out the route job, the fleet probe's `local box enrolled`
   gate, the two required gates, CI health and its `Routing slip transport`
   job. Split the sum the way H8 does (`slip`, `queue`, `none`, `fallback`,
   `unrouted`), so the minutes the queue rule sent away are visible.

The CI health report of every window already carries the H8 sum and the route
fallbacks by reason (`slipFallbacks`); the day's figures above are its windows
added up, computed afresh from the API so a missed window does not hide one.

## Gates

- `packages/ci-gh-actions/test/routing-slip.test.ts`,
  `packages/ci-gh-actions/test/runner-routing.test.ts`
- `scripts/test/runner-routing.test.ts` (M4, M8, reader agreement),
  `scripts/test/routing-slip-probe.test.ts` (Git Data API calls)
