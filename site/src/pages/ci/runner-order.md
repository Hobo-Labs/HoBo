---
layout: ../../layouts/Docs.astro
title: Runner order and relay jobs
description: "How a committed runner order sends each GitHub Actions job to the first runner that can take it, the two ways a relay job is answered, and which parts have run in production."
---

# Runner order and relay jobs

A **runner order** is a list you commit: for example "the HoBo fleet, then my machines, then Blacksmith while it is under $100 this month, then GitHub-hosted". A job takes the first runner type in the list that can run it now. Nothing is ranked; the list is walked as written. The decision record is [ADR-0183](https://github.com/Hobo-Labs/HoBo/blob/main/docs/design/adr/runner-order.md).

## Where it lives

The order is the `runnerOrder` block in `.hobo/ci.json`. A change to it is a commit someone reviews; no dashboard or variable carries it. A block that is there but broken is refused with the parser's sentence, never replaced by a default.

## The relay job

A workflow puts a small **relay job** in front of the real one. The relay job names the runner types the job may use, and the real job reads the answer in `runs-on`. `hobo ci init --relay` writes it; `hobo ci init --undo` takes it out again.

| Mode | Who answers | Needs |
|---|---|---|
| **Job mode** | A copy of the evaluator, run as the relay job on a GitHub-hosted runner | Nothing deployed. The job's own token reads the queue |
| **Relay mode** | A HoBo node that claims the job labelled `hobo-relay` and completes it, so no runner minute is billed | A deployed relay, and `relayJobs.answer` turned on for the node and the repository |

One relay output can feed a matrix or several jobs. When nothing in the order can take the job, the relay job fails with the reason as an annotation and the job behind it does not start. When the only runners that fit are busy, the job waits on that runner's label.

## Around it

| Command | What it does |
|---|---|
| `hobo ci route` | Shows the decision for a job and every step passed over, with the reason |
| `hobo ci machine connect` | Connects this computer; each job gets a fresh container. `pause`, `resume`, `share` and `remove` manage it |
| `hobo ci provider-health` | Lists hosted runner types that missed jobs, and clears one |
| `hobo ci rerun --reroute` | Re-runs a run's relay job so it decides again |
| `hobo ci activity`, `usage`, `performance`, `signals`, `diagnose` | Where jobs ran and why, minutes and spend, times, wasted time, and why a job failed |

The relay also serves a read-only dashboard, a read API with an OpenAPI description and read-only MCP tools.

## Status honesty

Each capability is one case on the generated [parity scorecard](https://github.com/Hobo-Labs/HoBo/blob/main/docs/ci/parity-scorecard.md). A case passes at its tier or it is not claimed.

| Run in production | Built, not yet run in production |
|---|---|
| `hobo ci diagnose` on a real failed run of the HoBo repository | Relay mode (off by default until one live run shows a relay job answered with no billed minute) |
| `route`, `init` and `signals` against the HoBo repository | Job mode's relay workflow, machine connect, runner-less checks, the billing reader |

## Related

[HoBo CI overview](/HoBo/ci/) · [Route table](/HoBo/ci/route-table/) · [Providers](/HoBo/ci/providers/)
