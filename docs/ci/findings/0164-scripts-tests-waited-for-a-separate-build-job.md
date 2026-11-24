---
type: CI Performance Finding
title: "Finding 164: scripts tests waited for a separate build job"
description: "A pull-request run of HoBo CI Fabric built the scripts-test packages in a scripts-tests-build job, then waited for runners again before the four scripts-tests shards could start. Since every gate job restores the main build cache, each shard now builds what it imports itself, which removes one serial stage and one runner pickup."
tags: [hobo, ci, performance, turbo, scripts-tests]
---

# Finding 164: scripts tests waited for a separate build job

## Measurements

Run 45322146069 of HoBo CI Fabric, the scripts lane after the route job:

- `scripts-tests-build` took 1.5 minutes: it built the packages the scripts tests import, packed every `dist/` tree into a tarball and uploaded it as an artifact.
- The four `scripts-tests` shards needed that job, so they queued only after it finished and then waited about 3.5 minutes for runners under contention.
- The shards took about 3 minutes each, after downloading and extracting the tarball.

The lane's critical path was route, then build (1.5 minutes), then a second runner pickup (3 to 5 minutes), then the shards (3 minutes).

The separate build existed because each shard rebuilding the import graph from an empty cache cost more than the hand-off. Since [finding 162](0162-merge-queue-shards-rebuilt-every-package-one-at-a-time.md), every gate job restores the whole-workspace `main-build` Turbo cache a push to main saves; shard 0 of workspace tests in the same run saw 100 of 101 build tasks hit it.

## Fix

- The `scripts-tests-build` job and its `dist/` tarball artifact are gone. `scripts-tests` needs only `route` and `ci-runner-image`, so its shards start as soon as the route job does.
- Each shard runs "Build the packages the scripts tests import": the same step a signed local run already used, with the `scripts-test-imports.mts` and `affected-lanes.mts` filters, a 6-minute limit, and the same fail-closed empty-base check. It now runs whenever the scope step selects the lane, in CI as locally.
- The shards restore `main-build` and then their own `scripts-tests` Turbo archive. Only shard 0 prunes and saves that archive. [Finding 155](0155-merge-queue-vitest-file-shards-and-release-integration-lane.md) gave the scripts matrix no save because the build job was its sole saver; without that job nothing else seeds `scripts-tests`, so one shard takes the save, as one shard of every other matrix does, and four shards never race to write the same key.
- The PR impact gate no longer needs or checks the build job; it requires the four shards as before.

## Expected effect

The scripts lane loses one serial stage and one runner pickup, about 3 to 5 minutes of a pull-request or merge-group run under contention. Each shard pays a mostly cached build instead of an artifact download and extract.

## Remaining limits

- A change that reaches many packages the scripts tests import rebuilds them in all four shards rather than once; the main build cache only covers what main already built.

`.github/workflows/actions.lock` no longer pins `actions/download-artifact` for `hobo-ci.yml`, which stopped using it with the build job.
