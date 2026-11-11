---
type: CI Performance Finding
title: "Finding 113: main CI starved by cancel-in-progress"
description: "Every main push cancelled the running main Fabric run; with the merge queue landing faster than a run finishes, no main run went green for hours and nothing released."
tags: [hobo, ci, main, merge-queue, release, concurrency]
---

# Finding 113: main CI starved by cancel-in-progress

## Evidence

On 2026-11-11 no HoBo CI Fabric `push` run on `main` created between 19:59 and 22:41 UTC finished green. One failed on GitHub's artifact service; every other one was cancelled.

| Run | Commit | Created | Ended |
| --- | --- | --- | --- |
| 43094500900 | `6e1a5e2c` (#1894) | 20:13 | failed (trace upload); its re-run cancelled 21:42 |
| 43092278398 | `245c10b9` (#1888) | 19:59 | cancelled 20:16 |
| 43105039437 | `abc2b78c` (#1890) | 21:39 | cancelled 21:46 |
| 43105868960 | `23ad2cd3` (#1901) | 21:45 | cancelled 22:01 |
| 43107920330 | `13d54000` (#1900) | 21:59 | cancelled 22:26, still in its test shards |
| 43111008403 | `176b7ec5` (#1896) | 22:21 | cancelled 22:26 |
| 43111719541 | `41fc1996` (#1895) | 22:26 | cancelled 22:36 |
| 43112738544 | `7dd8858c` (#1902) | 22:33 | cancelled 22:42 |
| 43113785951 | `cd1b984b` (#1903) | 22:40 | (running when this was written) |

A full main run takes longer than 26 minutes when its shards wait for trunk slots; the merge queue landed a commit every 5 to 15 minutes.

Two workflows run only after a **successful** main Fabric run, so both stopped:

- `release-hobo.yml`, the main-train release (no tag since `v0.0.0-alpha.2`). Every release run in that window skipped at its gate.
- `ci-deps-publish.yml`, the deps image publish.

## Cause

`hobo-ci.yml` cancelled an in-progress `push` run when a newer push started (`cancel-in-progress` for `push`). The aim was to stop a superseded run from holding box slots ([finding 89](0089-superseded-main-push-held-trunk-slots.md)). That only works while pushes are further apart than one run takes. Above that rate every run is cancelled before it finishes, and the work each one did is thrown away.

## Fix

- **Main pushes queue instead of cancelling.** `cancel-in-progress` is now `pull_request` only. GitHub lets the running main push finish, keeps the newest push waiting, and drops any older waiting run. That dropped run's commits are in the newest tree, and the main gate tests from the last green main run. Throughput is at least one finished main run per run duration, however fast the merge queue lands.
- **The fleet poller no longer treats a waiting run as replacing the running one.** `supersededMainFabricPushRunIds` used to mark every older queued or in-progress main push superseded and skip its jobs. A newer run waiting on the concurrency group would then have stopped the running run's queued shards being picked up, and the two would deadlock. Only a newer run that has **started** (`in_progress`) now replaces an older one. That still covers finding 89's case, an older run winding down behind a started newer one.
- The release gate measures from the last release tag ([`docs/release/pipelines.md`](../../release/pipelines.md)), so commits whose own run was dropped still ship with the next green run.

## Verified

- `packages/ci-gh-actions/test/superseded-main-push.test.ts`. "Never starves the running main push for a newer one still waiting its turn" fails against the previous poller and passes now. "Still drops a queued older run once a newer one has started" keeps finding 89's behaviour.
- `scripts/test/ci-fabric-concurrency.test.ts` pins `cancel-in-progress` to `pull_request` only.

## Not changed

- The poller change reaches the fleet only when the box worker is redeployed. Until then the old rule applies. If GitHub reports a run waiting on concurrency as `pending`, the old rule already ignores it. If GitHub reports it as `queued`, the running run's not-yet-started jobs are skipped by fleet boxes until the redeploy, but ARC pods, which do not use this poller, still pick them up.
