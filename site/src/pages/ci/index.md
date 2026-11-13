---
layout: ../../layouts/Docs.astro
title: HoBo CI
description: "Where your CI jobs run: one runner label, admission against the budget policy, and a fleet of owned and rented providers ranked by the Dispatcher."
---

# HoBo CI

**HoBo CI** runs your GitHub Actions jobs on capacity you choose. A workflow asks for one label, `runs-on: hobo`. The **relay** admits each queued job against budget and capacity, and a host starts a one-shot runner for exactly that job.

Which host is a **standing decision**: the same idea as [continuous migration](/HoBo/cicd/migration/), applied to CI. The [Dispatcher](/HoBo/reference/packages/) ranks providers on what the job would really cost, and the budget policy admits or refuses. There is no separate selection engine with different rules.

## In this section

| Page | Topic |
|---|---|
| [Providers](/HoBo/ci/providers/) | What each provider costs, who it serves, how to connect it |
| [Fleet balancing](/HoBo/ci/fleet-balancing/) | Eligibility → price → policy, on worked decisions |
| [Route table](/HoBo/ci/route-table/) | The routing slip: how the box relay hands each run its label |
| [Host health](/HoBo/ci/host-health/) | The box watching its own CPU, memory and disk |
| [Errors & codes](/HoBo/reference/errors/#ci-fleet) | Stable refusal codes (reference) |

## Words used here

| Term | Meaning |
|---|---|
| **Relay** | The service that receives GitHub's job events and admits jobs |
| **Box** | A machine you own running the HoBo worker; it starts one container per job |
| **Provider** | Anywhere a runner can come from: the box, a rented service, GitHub's own runners |
| **Fleet** | Every provider one account has connected |
| **Offer** | One connected provider on one account: its label, rate and ceiling |
| **Lease** | The relay's record that a job holds capacity and money |

## Two ways a job gets a runner

GitHub matches a job to a runner by label, and fixes the label when the job is queued. That splits every provider into one of two kinds.

| Kind | How it works | When it can be chosen |
|---|---|---|
| **Inject** | The job keeps the label `hobo`. The relay starts a runner with that label on compute it controls. | Any time, including after the job is waiting |
| **Label** | The provider's own GitHub App brings the runner. The job has to ask for the provider's label. | Only before the job is queued |

Injected capacity is the only kind that can rescue a job that is already waiting. Label capacity has to be chosen ahead of the queue; that is what the box relay's [routing slip](/HoBo/ci/route-table/) is for.

## What a job goes through

| Step | Question | Decided by |
|---|---|---|
| Eligibility | Can this provider run the job at all? | Facts about the provider: visibility, ownership, Docker, forks, isolation, health, free slots |
| Price | What does the job add to this month's bill there? | The pricing engine, ranked by the Dispatcher |
| Policy | Is that cost allowed? | The budget policy, evaluated for every candidate |

A refusal at any step is a **stable code**, never prose to string-match.

## Status honesty

Pre-release, like the rest of HoBo; the [Trail map](/HoBo/guide/status/) lists what runs today.

| Runs today | Not yet |
|---|---|
| Box admission on `hobo` and `hobo-trunk` | A workflow that reads the route table |
| Provider models, pricing and fleet balancing | Counting label-routed jobs against the budget |
| Route table publishing (off by default) | Host drivers for the eleven sandbox providers, from Agent37 to Runloop |
| Box host health | Health for rented providers |

## Related

[CI/CD & continuous delivery](/HoBo/cicd/) (how a change ships) · [FinOps](/HoBo/operations/finops/) · [Policy plane](/HoBo/reference/policy/) · [Troubleshooting](/HoBo/troubleshooting/)
