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
2. **The variable was fetched with a token that cannot read it.** The route job asked the REST API for the variable with the job's `GITHUB_TOKEN`. That endpoint needs the **Variables** repository permission ([permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)), which a workflow's `permissions:` block cannot grant. The failed read was caught and also read as "unset". The mesh snapshot beside it (`HOBO_CI_FLEET_STATE`) already came from the `vars` context for this reason. Not observed directly: the script swallowed the error, so no log shows the status.
3. **Four workflows did not check the parser out.** `release-hobo.yml`, `release-pricing.yml`, `release-ts-autocode.yml` and `pricing-ci.yml` sparse-checkout `route-runner.mts` and `fleet-overflow.ts` but not `capacity.ts`. The import failed, the step fell back, and every run of those workflows that was not pinned went to GitHub-hosted. [Finding 96](./0096-main-fabric-workspace-shard-regression.md) fixed the same crash for `hobo-ci.yml` only.

## Fix

- **One shape.** The per-label record and its builder, parser and types are removed from `capacity.ts`, which keeps the memory arithmetic the worker uses. `#FleetCapacityPublished` (`packages/ci/data-models/ci.cue`) is the only schema of the variable.
- **The route job reads that shape** (`parseFleetCapacity` in `route-runner.mts`, no imports beyond `fleet-overflow.ts`, so nothing new to check out or install). It passes over fields it does not know: the job runs the reader of the commit it checked out, which can be older than the worker.
- **The value comes from `vars`**: the route step takes a `fleet-capacity` input and all six routed workflows pass `vars.HOBO_CI_FLEET_CAPACITY`.
- **Decision.** The fleet is left only when the record is at most five minutes old, the box reports `trunkMemoryAdmit: false`, and `arc.freeSlots` is 0. A box with no free slot is busy, not out of room, and stays with the queue limits; a stale, undated, unreadable or verdict-less record changes nothing. A refusal is not waited on for the probe.
- **The log line says what was read** or why nothing was: an unreadable record no longer reads as "unset".

## Not changed

- **The worker does not publish `trunkMemoryAdmit` yet.** [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935) adds it and edits the publisher files, so they are untouched here. Until a worker with that change runs, the route job reports the slots and never leaves the fleet on capacity.
- #1935 computes the verdict from one `MemAvailable` reading without the committed memory and low-water window of finding 142; the route job trusts whatever verdict the box publishes.

## Measure

- A **Route runners** log on `hobo-ci.yml` shows `fleet capacity (N s old): …` instead of `fleet capacity unset` while the box daemon runs with `HOBO_CI_FLEET_ROUTES=1`.
- **Route runners** in `release-hobo.yml` and the pricing workflows logs a `runner:` line and no `the routing script failed` warning.
- After #1935 is deployed: a run started while the box logs `hobo_ci_memory_admission_wait` with `reason: memory-headroom` and the mesh has no free slot is routed off the fleet with `so the fleet is not asked`.

## Verified

- `node --import tsx --test scripts/test/route-runner.test.ts` — *the box's capacity snapshot*, *the routing decision with the box's capacity*, *the script with the box's capacity* (the record byte for byte as `fleetCapacityVariableValue` writes it, through `main`), *the workflows that route* (every routed workflow checks out what the script loads and passes the variable).
- `packages/ci` tests and typecheck; `packages/ci-gh-actions` tests and typecheck.
- Not verified on GitHub: the `vars` value reaching the step, and cause 2's status code.
