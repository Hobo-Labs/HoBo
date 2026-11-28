---
layout: ../../layouts/Docs.astro
title: CI runner routes
description: "Which runner label each class of job would ask for under HoBo CI runner routing, and why the decision is no longer published as a repository variable."
---

# CI runner routes

A **label** provider can only take a job that asks for its label, and GitHub fixes the label when the job is queued. So the choice of label has to be made before that. [Runner routing](/HoBo/ci/fleet-balancing/) makes it: it balances a representative job of each class against the account's connected providers.

| Class | Stands for |
|---|---|
| `pr` | A pull request from a branch of the repository |
| `fork` | A pull request from a fork |
| `trunk` | A push, a manual run or a merge-queue build |

While the box has room, every class stays where it is today:

<!-- generated:routes-box-free:start -->
<!-- Generated from the runner routing code by packages/ci/scripts/runner-routing-docs.ts. Do not edit by hand. -->

```json
{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}
```

<!-- generated:routes-box-free:end -->

When the box is full, new jobs are pointed at the best provider that can take them:

<!-- generated:routes-box-full:start -->
<!-- Generated from the runner routing code by packages/ci/scripts/runner-routing-docs.ts. Do not edit by hand. -->

```json
{"fork":"hobo","pr":"blacksmith-4vcpu-ubuntu-2404","trunk":"blacksmith-4vcpu-ubuntu-2404"}
```

<!-- generated:routes-box-full:end -->

Both are runner routing's real output for the catalog in [Runner routing](/HoBo/ci/fleet-balancing/). A class keeps its own label when its best provider is injected, or when none is admitted: that is where a waiting job can still be rescued.

## How a workflow learns the route

The box relay writes its decision where the **Route runners** job reads it with its own token: a **routing slip**, the message of a commit at the git ref `refs/hobo/routing-slip` ([ADR-0181](https://github.com/Hobo-Labs/HoBo/blob/main/docs/design/adr/routing-slips.md#adr-0181)). No environment variable and no repository variable carries routing: the settings are committed in `.hobo/ci.json` under `runnerRouting` (the labels, the queue limits, the box's slot split, the hold times, the external pools and the self-update interval), and a repository test fails on any read of a routing name from the environment or from `vars.`.

Each slip holds one route per class: a `runner` (one of `runnerRouting.labels`), a `tier` (`fleet`, `local` or `github`) and a reason code (`fleet-open`, `fleet-busy`, `no-node`, `no-capacity`, `stalled` or `pinned`), never a figure. A busy box is `fleet-busy`: still the fleet.

| Behavior | Rule |
|---|---|
| Writer | The box that leads the fleet's slip election; a box outside a fleet leads itself |
| Writing | When the decision changes, and every 3 minutes as a heartbeat; at most 20 writes a minute and 300 an hour; 10 minutes of back-off after a 403 or 429; a pass that has not finished in 60 seconds is abandoned and logged, so the next one runs |
| Lifetime | 10 minutes from issue |
| Reading | The route job: two GET calls, 3 seconds at most |
| No usable slip | Missing, expired, for another repository or naming an unknown label: the route job reads GitHub's queue exactly as before, and says why in a `hobo-ci-route-fallback` warning |
| Monitoring | CI health counts every fallback by reason, and proves the slip's write and read calls on every push to `main` and every two hours on a probe ref |
| Staying current | The box relay updates itself from `main` every 3 hours when idle, so a committed change to `runnerRouting` reaches it without a manual restart |

The slip does not carry the balanced table above: its classes say fleet, local box or GitHub-hosted, and a paid label provider is never named.

## Status honesty

Choosing a label provider ahead of the queue still needs two things before HoBo's own workflows rely on it:

| Needed | Why |
|---|---|
| Jobs that run off the box | HoBo's jobs assume the box's toolchain image and mounts |
| Counting label-routed jobs | A job that asks for a provider's label never passes relay admission, so it holds no lease: its cost does not reach the budget and its slot does not count. Until it does, a route to a paid provider is bounded only by that provider's own spend limit |

## Related

[Runner routing](/HoBo/ci/fleet-balancing/) · [Providers](/HoBo/ci/providers/) · [Host health](/HoBo/ci/host-health/)
