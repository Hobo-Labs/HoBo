---
layout: ../../layouts/Docs.astro
title: CI route table
description: "How the HoBo CI relay publishes which runner label each class of job should ask for, how to turn it on and off, and what it does not do yet."
---

# CI route table

A **label** provider can only take a job that asks for its label, and GitHub fixes the label when the job is queued. So the relay decides before that, and publishes the decision where a workflow can read it without running anything: one repository variable, **`HOBO_CI_FLEET_ROUTES`**.

## What is published

After a dispatch pass the relay [balances](/HoBo/ci/fleet-balancing/) three representative jobs against the account's connected providers.

| Class | Stands for |
|---|---|
| `pr` | A pull request from a branch of the repository |
| `fork` | A pull request from a fork |
| `trunk` | A push, a manual run or a merge-queue build |

While the box has room, every class stays where it is today:

<!-- generated:routes-box-free:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

```json
{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}
```

<!-- generated:routes-box-free:end -->

When the box is full, new jobs are pointed at the best provider that can take them:

<!-- generated:routes-box-full:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

```json
{"fork":"hobo","pr":"blacksmith-4vcpu-ubuntu-2404","trunk":"blacksmith-4vcpu-ubuntu-2404"}
```

<!-- generated:routes-box-full:end -->

Both are the relay's real output for the catalog in [Fleet balancing](/HoBo/ci/fleet-balancing/). A class keeps its own label when its best provider is injected, or when none is admitted: that is where a waiting job can still be rescued.

## Turn it on

| Step | Detail |
|---|---|
| 1. Permission | Give the HoBo CI GitHub App repository permission **Variables: write** |
| 2. Flag | Start the box daemon with `HOBO_CI_FLEET_ROUTES=1`. `0` or unset is off; any other value refuses to start |

The daemon's startup record reports `publishFleetRoutes`.

## How it behaves

| Behavior | Rule |
|---|---|
| Computing | At most every 15 seconds for a repository |
| Writing | Only when the value changes, and at most once a minute, so a label cannot flap with every freed slot |
| A successful write | Logs `hobo_ci_fleet_routes_published` with the repository and value |
| A refused write | Logs `hobo_ci_fleet_routes_error` with the HTTP status; not attempted again for ten minutes |
| A failure to publish | Never disturbs admission. Jobs on `hobo` are admitted exactly as before |

## Turn it off

The variable **outlives the daemon**.

| Stop | What happens to the table |
|---|---|
| Drain | Every class is put back on its own label before the daemon exits |
| Handoff (the default for a deploy) | Left in place for the successor |
| Restart with publishing off | Untouched |
| Crash | The last table stays in force |

To turn publishing off for good, **delete the variable**.

## Reading it from a workflow

The intended shape is one expression per job, falling back to today's label when the variable is unset or a class is missing:

```yaml
jobs:
  test:
    runs-on: ${{ fromJSON(vars.HOBO_CI_FLEET_ROUTES || '{}').pr || 'hobo' }}
```

## Status honesty

**No HoBo workflow reads the variable yet**, and the expression above has not been run on HoBo's own CI. Turning publishing on changes no job's runner today, so it is safe to enable in order to watch what the fleet would choose. Two things come first:

| Needed | Why |
|---|---|
| Jobs that run off the box | HoBo's jobs assume the box's toolchain image and mounts |
| Counting label-routed jobs | A job that asks for a provider's label never passes relay admission, so it holds no lease: its cost does not reach the budget and its slot does not count. Until it does, a route to a paid provider is bounded only by that provider's own spend limit |

## Related

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Providers](/HoBo/ci/providers/) · [Host health](/HoBo/ci/host-health/)
