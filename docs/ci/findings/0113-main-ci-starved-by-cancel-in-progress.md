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
- **The fleet poller no longer lets a waiting run replace the running one.** `supersededMainFabricPushRunIds` used to mark every older queued or in-progress main push superseded and skip its jobs. If GitHub reports a run waiting on the concurrency group as `queued` rather than `pending`, the running run's not-yet-started shards would have been skipped on fleet boxes. Now only a newer run GitHub reports `in_progress` replaces an older one. GitHub can report a run that already has jobs running as `queued` (run 43113785951 did, with Main full gate in progress), so this misses some replacements rather than inventing one. Admission order (newest push first) still covers finding 89's case, which needs a manual cancel or a re-run now that pushes queue. The prewarm hint (`newestMainFabricPushRunId`) also prefers the started run.
- **The worker image of a dropped push is published after the next green run.** HoBo CI Fabric builds the worker image on a main push only when that push's own commits list an image input (`mise.lock`, `mise.toml`, `packages/ci-gh-actions/deploy/ci-runner/`, and so on). A dropped push is listed by no later push, so its image would never be built or published, and release jobs on ARC pods pull the worker from GHCR. `ci-deps-publish.yml` now has a second job that runs after every green main run. It asks GHCR for that commit's content key (`ensure-ci-worker-image.mts --published-status`), and if GHCR lacks it, builds the image from that commit and publishes it, then fails loudly if GHCR still lacks it. Before building it drops any image already under that tag on the box, because pull requests build there too and `build.sh` would reuse it as is. The job is off the main gate's path and is never cancelled by a newer green run. (A first attempt ran the check inside the Fabric run on every push. That put a runner pickup and a GHCR round trip in front of Main full gate, failed the run when neither the box nor GHCR had the image, and could publish an image a pull request had built, so it was dropped before merging.)
- **The secret scan covers dropped pushes.** On a main push it scanned `before..sha`, the push's own range. It now starts from the last green main commit when that is further back. The lookup lists HoBo CI Fabric's own runs (30 at most) with a 15 s limit; when it finds none it falls back to `before..sha`, the old range. A real secret on main now keeps every later main run red until it is removed or listed in `.gitleaksignore`, because each run rescans from the last green commit. That fails closed, and it also holds back the release train.
- **Skipped completions no longer displace real work.** A dropped or failed main run still completes and fires `workflow_run`. The release train's queue and the deps publish's cancel group are now keyed by that run's conclusion, so a completion the job skips cannot replace a waiting release or cancel a running publish.
- The release gate measures from the last release tag ([`docs/release/pipelines.md`](../../release/pipelines.md)), so commits whose own run was dropped still ship with the next green run.

## Verified

- `packages/ci-gh-actions/test/superseded-main-push.test.ts`. "Never starves the running main push for a newer one still waiting its turn" fails against the previous poller and passes now. "Still drops a queued older run once a newer one has started" keeps finding 89's behaviour. "Hints prewarm at the started main push" covers the prewarm hint.
- `scripts/test/ci-fabric-concurrency.test.ts` pins `cancel-in-progress` to `pull_request` only.
- `scripts/test/ensure-ci-worker-image.test.ts` runs `--published-status` against a stub Docker and checks what it reports for each of host and GHCR present or absent. `packages/ci-gh-actions/test/deps-image-scope.test.ts` pins the publisher job: it runs after a green main run only, is never cancelled, drops the box's tag before building, and fails unless GHCR then has the image.
- `scripts/test/gitleaks-main-scan.test.ts`: the scan starts from the last green main commit when it is behind the push's own base, and keeps the push range otherwise. `scripts/test/resolve-main-test-base.test.ts` pins the workflow-scoped run list and its time limit.

## Not changed

- The poller change reaches fleet boxes only when the box worker is redeployed. Until then the old rule applies. If GitHub reports a run waiting on concurrency as `pending`, the old rule already ignores it. If GitHub reports it as `queued`, fleet boxes skip the running run's not-yet-started jobs until the redeploy. ARC still serves them: the `hobo-trunk` scale set (`hobo-trunk-runner-*`, which ran this run's deps layer and Main full gate) takes jobs from GitHub's own queue, not from this poller.
- A pull request and a main push still decide whether to build the runner image from their own diff, and a merge-group run never builds it. Until the next green main run's publisher finishes, a release can find no worker image in GHCR for a key that only a dropped push introduced.
- A manual dispatch of `ci-deps-publish.yml` and a run after a green main push no longer share a concurrency group. Both publish content-keyed tags idempotently, so they may overlap.
