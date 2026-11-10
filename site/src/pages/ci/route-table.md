---
layout: ../../layouts/Docs.astro
title: CI route table
description: "How the HoBo CI relay publishes which runner label each class of job should ask for, how to turn it on, and what it does not do yet."
---

# CI route table

A label provider can only take a job that asks for its label, and GitHub fixes the label when the job is queued. So the relay has to decide before that, and publish the decision somewhere a workflow can read it without running anything.

That place is one repository variable, `HOBO_CI_FLEET_ROUTES`. It holds the label each class of job should ask for.

## What is published

After a dispatch pass, the relay [balances](/HoBo/ci/fleet-balancing/) three representative jobs against the account's connected providers and writes the result.

| Class | Stands for |
|---|---|
| `pr` | A pull request from a branch of the repository |
| `fork` | A pull request from a fork |
| `trunk` | A push, a manual run or a merge-queue build |

While the box has room, every class stays where it is today:

<!-- generated:routes-box-free:start -->

```json
{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}
```

<!-- generated:routes-box-free:end -->

When the box is full, new jobs are pointed at the best provider that can take them:

<!-- generated:routes-box-full:start -->

```json
{"fork":"hobo","pr":"blacksmith-4vcpu-ubuntu-2404","trunk":"blacksmith-4vcpu-ubuntu-2404"}
```

<!-- generated:routes-box-full:end -->

Both values are the relay's real output for the catalog in [Fleet balancing](/HoBo/ci/fleet-balancing/).

A class stays on its own label when its best provider is an injected one, or when no provider is admitted. That is where a waiting job can still be rescued, because injected capacity can come to it later.

## Turn it on

1. Give the HoBo CI GitHub App repository permission **Variables: write**.
2. Start the box daemon with `HOBO_CI_FLEET_ROUTES=1`. `0` or unset is off, and any other value refuses to start.

The daemon's startup record reports `publishFleetRoutes`. Each successful write logs `hobo_ci_fleet_routes_published` with the repository and the value.

## How often it changes

- The table is computed at most every 15 seconds for a repository.
- The variable is written only when the value changes, and at most once a minute, so the label cannot flap with every freed slot.
- A refused write logs `hobo_ci_fleet_routes_error` with the HTTP status and is not attempted again for ten minutes.
- A failure to publish never disturbs admission. Jobs on `hobo` are admitted exactly as before.

## Turn it off

The variable outlives the daemon, so stopping the daemon does not clear it.

- A **drain** stop puts every class back on its own label before the daemon exits.
- A **handoff** stop, the default for a deploy, leaves the table for the successor.
- To turn publishing off for good, **delete the variable**. A daemon restarted with publishing off does not touch it, and a crash leaves the last table in force.

## Reading it from a workflow

No HoBo workflow reads the variable yet, so turning publishing on changes no job's runner today. It is safe to enable in order to watch what the fleet would choose.

The intended shape is one expression per job, falling back to today's label when the variable is unset or a class is missing:

```yaml
jobs:
  test:
    runs-on: ${{ fromJSON(vars.HOBO_CI_FLEET_ROUTES || '{}').pr || 'hobo' }}
```

This expression has not been run on HoBo's own CI. Two things have to be true before it is:

- **Jobs must run off the box.** HoBo's jobs assume the box's toolchain image and mounts. A job sent to another provider needs the same toolchain, for example by running in the published worker image.
- **Label-routed jobs must be counted.** A job that asks for a provider's label never passes through relay admission, so today it holds no lease: its cost does not reach the budget and its slot does not count against the provider. Until the relay records those jobs, a route to a paid provider is bounded only by that provider's own spend limit.

## Related

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Providers](/HoBo/ci/providers/) · [Host health](/HoBo/ci/host-health/)
