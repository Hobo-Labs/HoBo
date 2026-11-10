---
layout: ../../layouts/Docs.astro
title: HoBo CI
description: "Run GitHub Actions jobs on capacity you choose: one runner label, admission against budget, and a fleet balanced across owned and rented providers."
---

# HoBo CI

HoBo CI runs your GitHub Actions jobs on capacity you choose. A workflow asks for one label, `runs-on: hobo`. A relay admits each queued job against your budget and the capacity you have, and a host starts a one-shot runner for exactly that job.

It started with one host. This section covers what was added so a single full machine is no longer the whole story: a **fleet** of providers, compared on what a job would really cost on each, and admitted by the same budget policy that governs the rest of HoBo.

> **Pre-release.** The fleet balancer, the provider models, the route table and host health are in the codebase and tested. Two things are not done: no workflow reads the route table yet, and jobs routed to a provider by label are not yet counted against the budget. Each page says what is live and what is not.

## In this section

| Page | What it covers |
|---|---|
| [Providers](/HoBo/ci/providers/) | Every provider the fleet can price, what each costs, who each will serve, and how to connect one |
| [Fleet balancing](/HoBo/ci/fleet-balancing/) | How a provider is chosen for a job, with worked decisions |
| [Route table](/HoBo/ci/route-table/) | How the relay publishes its choice so a workflow can read it |
| [Host health](/HoBo/ci/host-health/) | How the box watches its own CPU, memory and disk |

## Two ways a job gets a runner

GitHub matches a job to a runner by label, and fixes the label when the job is queued. That splits every provider into one of two kinds.

| Kind | How it works | When it can be chosen |
|---|---|---|
| **Inject** | The job keeps the label `hobo`. The relay starts a runner with that label on compute it controls. | Any time, including after the job is already waiting |
| **Label** | The provider's own GitHub App brings the runner. The job has to ask for the provider's label. | Only before the job is queued |

Injected capacity is the only kind that can rescue a job that is already waiting. Label capacity has to be chosen ahead of the queue, which is what the [route table](/HoBo/ci/route-table/) is for.

## What a job goes through

1. **Eligibility.** Can this provider run the job at all? Repository visibility, ownership, Docker, forks, isolation, health and free slots.
2. **Price.** What does the job add to this month's bill there? The pricing engine answers, so included minutes and plan fees are handled the same way for every provider.
3. **Policy.** Does the budget policy allow that cost? Every candidate is evaluated, and a refusal names the rule.

[Fleet balancing](/HoBo/ci/fleet-balancing/) shows each step on real decisions.

## Related

[CI/CD & continuous delivery](/HoBo/cicd/) covers how HoBo ships *your app*. This section covers where *your CI jobs* run. [FinOps](/HoBo/operations/finops/) covers the budget policy both share. The design record is [CI fleet balancing](https://github.com/Hobo-Labs/HoBo/blob/main/docs/design/ci-fleet-balancing.md), and the operator runbook is the [runner queue guide](https://github.com/Hobo-Labs/HoBo/blob/main/packages/ci/RUNNER-QUEUE.md).
