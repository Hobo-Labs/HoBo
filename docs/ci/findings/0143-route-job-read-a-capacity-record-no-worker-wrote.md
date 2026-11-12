---
type: CI Performance Finding
title: "Finding 143: route job read a capacity record no worker wrote"
description: "The Route runners job parsed HOBO_CI_FLEET_CAPACITY as a per-label record only tests built, so it always logged 'fleet capacity unset'; in four workflows the same import crashed the script and sent every run to GitHub-hosted."
tags: [hobo, ci, routing, fleet, capacity, memory, sparse-checkout, github-hosted]
---

# Finding 143: route job read a capacity record no worker wrote

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

## Cause

1. **Two shapes for one variable.** `route-runner.mts` parsed `HOBO_CI_FLEET_CAPACITY` with `parseFleetCapacityVariable` (`capacity.ts`): `atMs` plus `hobo` and `hobo-trunk` records carrying `freeSlots`, `requiredMb`, `reserveMb`, `volatilityMb`, `admit`. The worker writes `fleetCapacitySnapshot` (`capacity-input.ts`): `{version: 1, admittedParallel, hobo: {freeSlots}, arc: {freeSlots}, publishedAt}`. Only tests ever built the per-label record. The parse returned nothing, and nothing read as "unset".
2. **The variable was fetched with a token that cannot read it.** The route job asked the REST API for the variable with the job's `GITHUB_TOKEN`. That endpoint needs the **Variables** repository permission ([permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)), which a workflow's `permissions:` block cannot grant. The route script swallowed the error, but **Main workspace plan** makes the same request and prints the status: `load-fleet-capacity: variables/HOBO_CI_FLEET_CAPACITY returned 403` in job `131146352582` of the run above and job `131259868933` of push run [43240626287](https://github.com/Hobo-Labs/HoBo/actions/runs/43240626287), each followed by `parallelCap=4`, the default. The mesh snapshot (`HOBO_CI_FLEET_STATE`) already came from the `vars` context.
3. **Four workflows did not check the parser out.** `release-hobo.yml`, `release-pricing.yml`, `release-ts-autocode.yml` and `pricing-ci.yml` sparse-checkout `route-runner.mts` and `fleet-overflow.ts` but not `capacity.ts`. The import failed, the step fell back, and every run of those workflows that was not pinned went to GitHub-hosted. [Finding 96](./0096-main-fabric-workspace-shard-regression.md) fixed the same crash for `hobo-ci.yml` only.

## Fix

- **One shape.** The per-label record and its builder, parser and types are removed from `capacity.ts`, which keeps the memory arithmetic the worker uses. `#FleetCapacityPublished` (`packages/ci/data-models/ci.cue`) is the only schema of the variable.
- **The route job reads that shape** (`parseFleetCapacity` in `route-runner.mts`, no imports beyond `fleet-overflow.ts`, so nothing new to check out or install). It passes over fields it does not know: the job runs the reader of the commit it checked out, which can be older than the worker.
- **The value comes from `vars`**: the route step takes a `fleet-capacity` input and all six routed workflows pass `vars.HOBO_CI_FLEET_CAPACITY`. It is still the variable the worker rewrites about once a minute; each run reads the value it has as the run starts.
- **Decision.** The fleet is left only when the record is at most three minutes old (three of the worker's writes; free memory moves by gigabytes inside a minute and the other tier is paid for), the box reports `trunkMemoryAdmit: false`, and `arc.freeSlots` is 0. A box with no free slot is busy, not out of room, and stays with the queue limits; a stale, undated, unreadable or verdict-less record changes nothing. A refusal is not waited on for the probe.
- **The log line says what was read** or why nothing was: an unreadable record no longer reads as "unset".

## Not changed

- **The worker does not publish `trunkMemoryAdmit` yet.** [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935) adds it and edits the publisher files, so they are untouched here. Until a worker with that change runs, the route job reports the slots and never leaves the fleet on capacity.
- #1935 computes the verdict from one `MemAvailable` reading without the committed memory and low-water window of finding 142; the route job trusts whatever verdict the box publishes.
- **The variable was empty.** On this change's own pull request the route step's environment showed `HOBO_CI_FLEET_CAPACITY:` with no value (run [43245922777](https://github.com/Hobo-Labs/HoBo/actions/runs/43245922777)), so the route job still logged `fleet capacity unset`. That is what a variable that does not exist looks like: the box is not publishing, or its writes are refused. Publishing needs `HOBO_CI_FLEET_ROUTES=1` on the box daemon and **Variables: write** on the App; the box's log (`hobo_ci_fleet_capacity_published` or `hobo_ci_fleet_capacity_error`) says which. Not checked: the box's log and the repository's variable list were not readable from this change.
- **Main workspace plan** still asks the API (cause 2); #1935 passes it the variable from `vars`.
- The record is as old as the worker's last write, up to a minute. A verdict that flips is not written sooner; that is the publisher's interval, in a file #1935 edits.

## Measure

- A **Route runners** log on `hobo-ci.yml` shows `fleet capacity (N s old): …` instead of `fleet capacity unset` while the box daemon runs with `HOBO_CI_FLEET_ROUTES=1`.
- **Route runners** in `release-hobo.yml` and the pricing workflows logs a `runner:` line and no `the routing script failed` warning.
- After #1935 is deployed: a run started while the box logs `hobo_ci_memory_admission_wait` with `reason: memory-headroom` and the mesh has no free slot is routed off the fleet with `so the fleet is not asked`.

## Verified

- `node --import tsx --test scripts/test/route-runner.test.ts` — *the box's capacity snapshot*, *the routing decision with the box's capacity*, *the script with the box's capacity* (the record byte for byte as `fleetCapacityVariableValue` writes it, through `main`), *the workflows that route* (every routed workflow checks out what the script loads and passes the variable).
- `packages/ci` tests and typecheck; `packages/ci-gh-actions` tests and typecheck.
- On GitHub: the `release-hobo.yml` route job of run [43245923258](https://github.com/Hobo-Labs/HoBo/actions/runs/43245923258) logged a `runner:` line and no crash.
- Not verified on GitHub: a non-empty record reaching the step. To check without moving any run, set the variable by hand to a record with `"trunkMemoryAdmit":true` and a current `publishedAt`, start a run, and read the route job's line.
