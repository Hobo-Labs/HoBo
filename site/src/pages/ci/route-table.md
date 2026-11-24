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

The relay no longer publishes this table as a repository variable. The variables that carried the route table and the box's capacity have been removed with the code that wrote them.

| Question | Answered by |
|---|---|
| Is the hobo fleet open, and how many slots are free? | The route job fetches the hobo fleet's **fleet verdict** and reads its capacity. Its mode values (`fleet`, `local`, `github`) and its output `tier=fleet` are unchanged |
| Which provider should take a job the fleet cannot? | Runner routing, as above, with the hobo provider's health and active jobs read from the same fleet capacity |

## Status honesty

Choosing a label provider ahead of the queue still needs two things before HoBo's own workflows rely on it:

| Needed | Why |
|---|---|
| Jobs that run off the box | HoBo's jobs assume the box's toolchain image and mounts |
| Counting label-routed jobs | A job that asks for a provider's label never passes relay admission, so it holds no lease: its cost does not reach the budget and its slot does not count. Until it does, a route to a paid provider is bounded only by that provider's own spend limit |

## Related

[Runner routing](/HoBo/ci/fleet-balancing/) · [Providers](/HoBo/ci/providers/) · [Host health](/HoBo/ci/host-health/)
