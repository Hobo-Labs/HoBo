---
type: CI Performance Finding
title: "Finding 146: route job read a capacity record no worker wrote"
description: "The Route runners job parsed HOBO_CI_FLEET_CAPACITY as a per-label record only tests built, through an API read a job token is refused, so it always logged 'fleet capacity unset'; in four workflows the same import crashed the script and sent every run to GitHub-hosted."
tags: [hobo, ci, routing, fleet, capacity, relay, sparse-checkout, github-hosted]
---

# Finding 146: route job read a capacity record no worker wrote

## Evidence

Scheduled main run [43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098) ([finding 142](./0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md)): the **Route runners** job logged

```text
runner: hobo (fleet): the fleet has nothing waiting, and in the last 60 minutes took up to 11 s to pick a job up; fleet capacity unset; no local box is enrolled
```

while the box had 2.4–4.4 GB free and a 4096 MiB job is admitted only above 7168 MiB.

Merge-queue release run [43239493135](https://github.com/Hobo-Labs/HoBo/actions/runs/43239493135), **Route runners** job `131255733370`:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/runner/work/HoBo/HoBo/packages/ci/src/fleet/capacity.ts' imported from /home/runner/work/HoBo/HoBo/scripts/ci/route-runner.mts
##[warning]runner routing did not run (the routing script failed); using GitHub-hosted runners
```

**Main workspace plan**, jobs `131146352582` (the run above) and `131259868933` (push run [43240626287](https://github.com/Hobo-Labs/HoBo/actions/runs/43240626287)):

```text
load-fleet-capacity: variables/HOBO_CI_FLEET_CAPACITY returned 403
main gate plan: scope=repo-wide, tests=all, parallelCap=4, …
```

## Cause

1. **Two shapes for one variable.** `route-runner.mts` parsed `HOBO_CI_FLEET_CAPACITY` with `parseFleetCapacityVariable` (`capacity.ts`): `atMs` plus `hobo` and `hobo-trunk` records carrying `freeSlots`, `requiredMb`, `reserveMb`, `volatilityMb`, `admit`. The relay writes `fleetCapacitySnapshot` (`capacity-input.ts`): `{version: 1, admittedParallel, hobo: {freeSlots}, arc: {freeSlots}, publishedAt}`. Only tests ever built the per-label record.
2. **A job's token cannot read a repository variable.** The route job asked the REST API with the job's `GITHUB_TOKEN`. That endpoint needs the **Variables** repository permission ([permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)), which a workflow's `permissions:` block cannot grant. The route script swallowed the error; Main workspace plan makes the same request and prints the 403 above, then plans with the default cap of 4.
3. **Four workflows did not check the parser out.** `release-hobo.yml`, `release-pricing.yml`, `release-ts-autocode.yml` and `pricing-ci.yml` sparse-checkout `route-runner.mts` and `fleet-overflow.ts` but not `capacity.ts`. The import failed, the step fell back, and every run of those workflows that was not pinned went to GitHub-hosted. [Finding 96](./0096-main-fabric-workspace-shard-regression.md) fixed the same crash for `hobo-ci.yml` only.
4. **The decision was in the wrong place.** Whether the fleet can take a run depends on memory admission, the mesh's free slots and the budget. The relay holds all three and already turns them into a routing decision (`fleetRouteTable`, published as `HOBO_CI_FLEET_ROUTES`, which no workflow reads). A workflow script judging a raw capacity record repeats that decision outside the relay, without its budget.

## Fix

- **The reader is removed.** `route-runner.mts` no longer asks for `HOBO_CI_FLEET_CAPACITY`, and its log line no longer says `fleet capacity unset`. It decides from the queue and the mesh snapshot, as it did in effect on every run.
- **The crash is gone with it.** The script loads only `fleet-overflow.ts`, which all six routed workflows check out. A test fails if the script loads a file a routed workflow does not check out, or a package the job never installs.
- **One shape.** The per-label record and its builder, parser and types are removed from `capacity.ts`, which keeps the memory arithmetic admission uses. `#FleetCapacityPublished` (`packages/ci/data-models/ci.cue`) is the only schema of the variable.

## Rejected

- **Passing the capacity record to the route step.** A first version of this change read the published record in `route-runner.mts`, handed to the step from the `vars` context through an action input and an environment variable, and left the fleet when a fresh record said the box could not admit by memory and ARC had no free slot. Rejected by the owner: capacity is the relay's concern, not a record for a workflow script to judge, and it is not to be carried in environment variables.

## Not changed

- **Capacity-aware routing is not built.** A run can still be sent to a fleet that cannot admit its jobs (cause 4). The answer has to come from the relay and reach a run before its jobs are queued: [ADR-0180](../../design/adr/fleet-verdict.md#adr-0180) has the route job ask the relay for a verdict. The relay's reporter is the part still to build.
- **Main workspace plan** still asks the API for the record and is refused (cause 2). [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935) hands it the variable through an environment variable, the mechanism rejected above.
- **The mesh snapshot** (`HOBO_CI_FLEET_STATE`) reached the route step through an action input and an environment variable until ADR-0180 removed that reader.
- **Nothing is publishing.** On this change's pull request `vars.HOBO_CI_FLEET_CAPACITY` and `vars.HOBO_CI_FLEET_STATE` were both empty (run [43245922777](https://github.com/Hobo-Labs/HoBo/actions/runs/43245922777)). Publishing needs `HOBO_CI_FLEET_ROUTES=1` on the box daemon and **Variables: write** on the App. Not checked: the box's log and the repository's variable list were not readable from this change.

## Measure

- **Route runners** in `release-hobo.yml`, `release-pricing.yml`, `release-ts-autocode.yml` and `pricing-ci.yml` logs a `runner:` line and no `the routing script failed` warning.

## Verified

- `node --import tsx --test scripts/test/route-runner.test.ts` — *the workflows that route* (fails on the previous script, which loaded `capacity.ts`).
- The script run from a copy holding only the two files the release workflows check out: it decides; on the previous code it exits with `ERR_MODULE_NOT_FOUND`.
- On GitHub, with the first version of this change: the `release-hobo.yml` route job of run [43245923258](https://github.com/Hobo-Labs/HoBo/actions/runs/43245923258) logged a `runner:` line and no crash.
- `packages/ci` tests and typecheck; `packages/ci-gh-actions` tests and typecheck.
