---
layout: ../../layouts/Docs.astro
title: Runner order
description: "How a committed runner order sends each GitHub Actions job to the first runner that can take it, how HoBo CI routes a job when it claims it, and which parts have run in production."
---

# Runner order

A **runner order** is a list you commit: for example "the HoBo fleet, then my machines, then Blacksmith while it is under $100 this month, then GitHub-hosted". A job takes the first runner type in the list that can run it now. Nothing is ranked; the list is walked as written. The decision record is [ADR-0183](https://github.com/Hobo-Labs/HoBo/blob/main/docs/ci/runner-order.md).

## Where it lives

The order is the `runnerOrder` block in `.hobo/ci.json`. A change to it is a commit someone reviews; no dashboard or variable carries it. A block that is there but broken is refused with the parser's sentence, never replaced by a default.

## Where routing happens

Routing happens in HoBo CI, never in a workflow. The only HoBo CI change a workflow gets is `runs-on` set to a HoBo label (`hobo ci init --apply` writes it); HoBo CI walks the order when it claims the job. HoBo ships no workflow that runs a routing or evaluator job.

In **relay mode** a HoBo node claims a check job (HoBo `pr-title` or `lint` steps only) labelled `hobo-relay` and completes it, so no runner minute is billed. It never routes: a job on that label that asks to be routed fails. It needs a deployed relay, and `relayJobs.answer` turned on for the node and the repository.

When nothing in the order can take the job, it fails with the reason as an annotation. When the only runners that fit are busy, the job waits on that runner's label.

## Around it

| Command | What it does |
|---|---|
| `hobo ci route` | Shows the decision for a job and every step passed over, with the reason |
| `hobo ci machine connect` | Connects this computer; each job gets a fresh container. `pause`, `resume`, `share` and `remove` manage it |
| `hobo ci provider-health` | Lists hosted runner types that missed jobs, and clears one |
| `hobo ci activity`, `usage`, `performance`, `signals`, `diagnose` | Where jobs ran and why, minutes and spend, times, wasted time, and why a job failed |

The relay also serves a read-only dashboard, a read API with an OpenAPI description and read-only MCP tools.

## Status honesty

Each capability is one case on the generated [parity scorecard](https://github.com/Hobo-Labs/HoBo/blob/main/docs/ci/parity-scorecard.md). A case passes at its tier or it is not claimed.

| Run in production | Built, not yet run in production |
|---|---|
| `hobo ci diagnose` on a real failed run of the HoBo repository | Relay mode (off by default until one live run shows a check job claimed with no billed minute) |
| | Machine connect, runner-less checks, the billing reader |
| | `route`, `init` and `signals` against the HoBo repository (no run linked yet) |

## Related

[HoBo CI overview](/HoBo/ci/) · [Route table](/HoBo/ci/route-table/) · [Providers](/HoBo/ci/providers/)
