---
type: CI Performance Finding
title: "Finding 145: fleet verdict channel operating record"
description: "Four CI signals were built and unit-tested on both sides but never seen carrying a value in production, and each failed into a default without telling anyone. Plan 0025 makes the relay the only judge of whether the fleet can take a run; this finding is its operating record, with the evidence gates of plan section 6.10 filled in as each is passed."
tags: [hobo, ci, routing, fleet, relay, verdict, monitoring, operations]
---

# Finding 145: fleet verdict channel operating record

**Status:** closed without a gate passed. Built in the stack `sdlc/routing-01` to `sdlc/routing-07`; the
hosted verdict channel was then retired before any gate of the operating checklist was passed
([plan 0026](../../plans/0026-relay-routing-slips.md), section 3.9; [ADR-0181](../../design/adr/routing-slips.md#adr-0181)):
its routes answer 404 and its store, reporter and enrollment are removed. The rows below stay unfilled as the
record of what was never observed.

Design: [plan 0025](../../plans/0025-relay-owned-runner-routing.md). Authority:
[ADR-0180](../../design/adr/fleet-verdict.md#adr-0180-amendment). Runbooks:
[Fleet verdicts (retired)](../../../packages/ci-vercel/README.md#fleet-verdicts-retired). Monitor: the CI health
monitor, `docs/ci/health-monitor.md` (layer 05 of the stack).

## Evidence

| Incident (2026-11-12) | Evidence | Cause |
| --- | --- | --- |
| A main run went to a fleet that could not admit its jobs; shards started 14–36 minutes late and two timed out | Run [43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098), [finding 142](./0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md) | Nothing that routes a run could see what the relay knew, and the main gate's jobs were pinned to `hobo-trunk` whatever the route job decided |
| Every unpinned run of four workflows went to paid runners | Run [43239493135](https://github.com/Hobo-Labs/HoBo/actions/runs/43239493135), [finding 146](./0146-route-job-read-a-capacity-record-no-worker-wrote.md) | The route script crashed on a file the workflow did not check out; the step fell back with a warning nobody read |
| The shard planner used its default cap in both runs checked | Jobs `131146352582`, `131259868933`: `variables/HOBO_CI_FLEET_CAPACITY returned 403` | A job token cannot read a repository variable; the failure was swallowed |
| A broken script test reached a green pull request | [#1943](https://github.com/Hobo-Labs/HoBo/pull/1943), `scripts/test/main-gate-workspace-shards.test.ts` | No pull-request job ran `scripts/test` |

**The shared pattern:** a signal was built and unit-tested on both sides, never observed carrying a value in
production, and failed into a default without telling anyone.

## Cause

Each channel between two deployed components was judged done when both ends passed their tests. None had a
production observation of a value crossing it, so a channel that carried nothing (a variable no worker wrote,
a read a job token is refused, a script that could not load) looked the same as one that worked. Every
consumer then fell back silently to a default.

## Fix

- **The relay decides, workflows ask** (plan 0025 sections 6.1–6.5). The box relay reports a fleet label
  blocked only while it is idle, admission would still refuse a job, and nothing else can take it. Reports are
  signed; the hosted relay keeps them, agrees them unanimously among enrolled reporters, bounds the blocked
  time with a daily allowance, and serves the verdict. The route job asks it; the main gate follows the route
  and asks again before shards.
- **Loud fallbacks** (6.6). Every fallback leaves a titled annotation; `ci-health.yml` reads them every two
  hours and opens an issue per breach.
- **Retirement** (6.8). The `HOBO_CI_FLEET_STATE` and `HOBO_CI_FLEET_CAPACITY` publishers are removed; no
  workflow may read a fleet variable (lint).
- **The smoke check probes the public origin.** `relay-deploy.yml` requires the verdict read at the origin
  `.hobo/ci.json` names to answer a verdict for this repository.
- **A rule for every such channel.** `AGENTS.md` and the pull-request template now say a change that adds or
  alters a channel between two deployed components is done only when one production observation of that
  channel carrying a value is linked. This finding is where that observation is linked for this channel.

## Operating record

Plan section 6.10, in order. Each gate's evidence must hold before the next step starts.

| Step | Do | Evidence before the next step | Measured | Date | Link |
| --- | --- | --- | --- | --- | --- |
| G1 | Merge the stack. Vercel deploys the hosted relay. The smoke check in `relay-deploy.yml` probes the public origin. Dispatch `ci-health.yml` once with `dry-run: true` | Smoke check green. The dry run's report is complete. Monitor: H2 clear over 24 hours with at least 20 asks | | | |
| G2 | Enroll the box (`fleet-reporter-enroll.mts`; add the entry to `HOBO_CI_FLEET_REPORTERS_JSON`). Set the box to `shadow`, declare the ARC pool and the minimum free runners (P3), restart the daemon | Status route shows the reporter live in `shadow` | | | |
| G3 | **Forced-pressure game day, shadow**: `hold-memory.mts --mb <enough to fail admission> --seconds 300` while CI is idle, with the rest of the fleet below the minimum | `lastBlockedAt` within 90 s of the start and `lastClearedAt` within 60 s of the end. The served verdict stayed open throughout | | | |
| G4 | Leave in `shadow` for 72 hours | H4 clear. `lastBlockedAt` history compared with H6 stalls, both recorded here | | | |
| G5 | Set `report`. Repeat the game day while a dispatched run is routed | The route notice says `refusedBy: relay` and the run's jobs use GitHub-hosted runners; after the hold ends, the next dispatched run stays on the fleet | | | |
| G6 | Seven days | H6 zero, H8 and H10 within bound | | | |
| G7 | Delete the repository variables `HOBO_CI_FLEET_STATE` and `HOBO_CI_FLEET_CAPACITY` | — | | | |

**Operating outcomes** (plan section 8), measured at the gates above:

| # | Outcome | Target | Proven at | Measured |
| --- | --- | --- | --- | --- |
| O1 | A forced block is served, and released | within 90 s and 60 s | G3, G5 | |
| O2 | Route jobs that got a relay answer | ≥ 95% over 7 days | G6 (H2) | |
| O3 | Routing fallbacks | 0 over 7 days | G6 (H1) | |
| O4 | Fleet-label jobs waiting past the stall limit | 0 over 7 days | G6 (H6) | |
| O5 | Verdict-blocked time per label | ≤ 240 minutes per window | G6 (H10) | |
| O6 | Time for the monitor to raise an injected fault | within two monitor runs (≤ 4 hours) | Game day: a routed workflow dispatched from a branch whose route checkout is broken; H1 opens | |

**Rollback.** Any step: its own switch. To take the code out: remove `HOBO_CI_FLEET_REPORTERS_JSON` and
`HOBO_CI_FLEET_VERDICT_SERVING` from the hosted relay's configuration first, then revert on `main`.
