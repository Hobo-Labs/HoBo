---
layout: ../../layouts/Docs.astro
title: CI providers
description: "Every runner provider the HoBo CI fleet can price: rate, included minutes, plan fee, limits, who each serves, and how to connect one."
---

# CI providers

The fleet has a financial model for each provider below. A model is one machine class at one provider: what a minute costs, what is included each month, what the plan costs, how many jobs it runs at once, and which repositories it will serve.

The tables on this page are generated from those models, so they are what the balancer actually uses. Rates are for the 4 vCPU class and were read from each vendor's own page on 2026-11-09. They are published list prices, not your invoice.

## What each provider costs

<!-- generated:providers:start -->

| Provider | Reaches a job by | USD per minute | Included each month | Plan fee | Jobs at once | Usable in policy today |
| --- | --- | --- | --- | --- | --- | --- |
| HoBo box worker | inject | 0 | — | — | set in policy | yes |
| Box of the agent that opened the pull request | label | 0 | — | — | 1 | yes |
| Remote actions-runner-controller scale set | label | 0 | — | — | set in policy | yes |
| Boat CI runner | label | 0.0006 (derived) | — | $20.00 | 100 | yes, through the bridge |
| Boat sandbox (API) | inject | 0.0006 (derived) | — | $20.00 | 100 | modelled only (no host driver) |
| Agent37 VM instance | inject | 0.000522 (derived) | — | — | 3 | modelled only (no host driver) |
| Jog runner | label | 0.0024 (derived) | 2500 min | — | set in policy | yes, through the bridge |
| Modal Sandbox | inject | 0.007932 (derived) | — | — | 100 | modelled only (no host driver) |
| Blacksmith runner | label | 0.008 (derived) | 1500 min | — | set in policy | yes |
| Depot runner | label | 0.012 | 1000 min | $20.00 | set in policy | yes |
| GitHub-hosted runner (public repository) | label | 0 | — | — | 20 | yes |
| GitHub-hosted runner (private repository) | label | 0.006 | — | — | 20 | yes |

<!-- generated:providers:end -->

**Reaches a job by** is the provider's kind: `inject` means the relay starts the runner, `label` means the job asks for the provider's label. See [HoBo CI](/HoBo/ci/) for the difference.

**Derived** marks a rate the vendor does not print for this machine class. It was computed from a figure the vendor does print, and the arithmetic is in [Sources](#sources).

**Usable in policy today** is whether a relay can be given this provider now:

- *yes* — name it as a provider in your CI policy.
- *yes, through the bridge* — accepted in policy, and reached through a companion workflow that hosts the runner. The bridge only serves trusted private repositories.
- *modelled only* — the fleet can price and rank it, but the relay has no driver to start a runner there yet, so policy does not accept it.

## Who each provider will serve

A provider that cannot run a job is never priced for it. These are the facts the balancer checks first.

<!-- generated:eligibility:start -->

| Provider | Public repos | Private repos | Orgs only | Docker | Fork PRs | Own machine |
| --- | --- | --- | --- | --- | --- | --- |
| HoBo box worker | yes | yes | no | yes | yes | yes |
| Box of the agent that opened the pull request | yes | yes | no | no | no | no |
| Remote actions-runner-controller scale set | yes | yes | no | yes | no | no |
| Boat CI runner | opt-in | yes | no | yes | no | yes |
| Boat sandbox (API) | yes | yes | no | yes | yes | yes |
| Agent37 VM instance | yes | yes | no | yes | yes | yes |
| Jog runner | no | yes | no | yes | no | yes |
| Modal Sandbox | yes | yes | no | yes | yes | yes |
| Blacksmith runner | yes | yes | yes | yes | no | yes |
| Depot runner | opt-in | yes | yes | yes | no | yes |
| GitHub-hosted runner (public repository) | yes | no | no | yes | yes | yes |
| GitHub-hosted runner (private repository) | no | yes | no | yes | yes | yes |

<!-- generated:eligibility:end -->

- **Public repos: opt-in** means the provider serves public repositories only after the account owner turns that on.
- **Orgs only** means the provider serves repositories owned by an organization, not a personal account.
- **Own machine** means each job gets a machine nothing else shares and that is discarded afterwards. Public repositories and pull requests require it, so a shared cluster or a workstation is never chosen for them.

## How a job is priced

The fleet does not multiply a rate by a duration. Each model becomes a rate card in HoBo's pricing engine, and the engine rates the month with and without the job. The difference is the job's cost.

<!-- generated:pricing:start -->

| Provider | 20-minute job | Same job after the included minutes are gone | Same job if it opens the plan |
| --- | --- | --- | --- |
| HoBo box worker | $0 | — | — |
| Box of the agent that opened the pull request | $0 | — | — |
| Remote actions-runner-controller scale set | $0 | — | — |
| Boat CI runner | $0.012 | — | $20.012 |
| Boat sandbox (API) | $0.012 | — | $20.012 |
| Agent37 VM instance | $0.01044 | — | — |
| Jog runner | $0 | $0.048 | — |
| Modal Sandbox | $0.15864 | — | — |
| Blacksmith runner | $0 | $0.16 | — |
| Depot runner | $0 | $0.24 | $20 |
| GitHub-hosted runner (public repository) | $0 | — | — |
| GitHub-hosted runner (private repository) | $0.12 | — | — |

<!-- generated:pricing:end -->

Three things fall out of pricing it that way, with no special cases:

- A job inside the included minutes costs nothing. The first minute past them costs the overage rate.
- A plan fee you are already paying is not the job's cost. A plan the job would have to open is, in full. The relay never opens a paid plan on its own.
- A price that was read too long ago has expired and is not used. A provider with no current price is not chosen.

## Connect a provider

Providers are listed in your CI policy file, `.hobo/ci.json`, each with a `kind`, a connection, and the label a job would ask for. A provider is off until `enabled` is `true`.

```json
{
  "id": "github-hosted",
  "kind": "github",
  "connectionRef": "github-hosted",
  "runsOn": "ubuntu-24.04",
  "enabled": false
}
```

A remote actions-runner-controller scale set is a `kubernetes` provider that names the set:

```json
{
  "id": "arc-remote",
  "kind": "kubernetes",
  "connectionRef": "arc-remote",
  "runsOn": "hobo-arc",
  "enabled": false,
  "scaleSet": { "name": "hobo-arc", "namespace": "arc-runners", "maxRunners": 8 }
}
```

Jog and Boat are accepted as kinds `jog` and `boat`:

```json
{ "id": "boat", "kind": "boat", "connectionRef": "boat", "runsOn": "boat", "enabled": false }
```

> **Upgrade the relay first.** A relay built before these kinds existed rejects the whole policy file when it meets one it does not know. Add `jog` or `boat` only once the relay reading the file includes them.

`ubuntu-latest` is rejected everywhere: a route has to name a concrete machine.

## Sources

Every model carries the page its numbers came from and the day they were read.

<!-- generated:sources:start -->

- **HoBo box worker** — read 2026-11-09 from <https://github.com/Hobo-Labs/HoBo/blob/main/packages/ci/RUNNER-QUEUE.md>. Operator-owned host; a job adds no marginal charge. Slots come from HOBO_CI_WORKER_SLOTS, not from this model.
- **Box of the agent that opened the pull request** — read 2026-11-09 from <https://github.com/Hobo-Labs/HoBo/blob/main/packages/ci-gh-actions/README.md>. The agent's session already pays for the machine; a job adds no marginal charge. One job at a time.
- **Remote actions-runner-controller scale set** — read 2026-11-09 from <https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/deploy-runner-scale-sets>. Operator-owned cluster; a job adds no marginal charge. Concurrency is the scale set's maxRunners, authored in policy.
- **Boat CI runner** — read 2026-11-09 from <https://docs.boat.dev/pricing.md>. Printed as $0.036 per hour for the default 4 vCPU / 8 GB size; 0.036 / 60 = 0.0006. $20/mo plan allows 100 sandboxes at once.
- **Boat sandbox (API)** — read 2026-11-09 from <https://docs.boat.dev/pricing.md>. Same machine and rate as the CI runner, started through POST /api/v1/sandboxes. 12 starts a minute, 200 a day on the $20 plan.
- **Agent37 VM instance** — read 2026-11-09 from <https://www.agent37.com/docs/agents-api/vm-instances.md>. Printed as $22.54 a month for 4 vCPU / 8 GB, billed by the minute; 22.54 / 43200 rounded up to the microdollar. Three instances at once until the wallet is topped up. Running the Actions runner there is untested.
- **Jog runner** — read 2026-11-09 from <https://usejog.com/docs/runners/>. $0.0024 a minute is printed. The 5,000 free minutes are counted at 2 vCPU and a 4 vCPU minute counts twice, so 2,500 here.
- **Modal Sandbox** — read 2026-11-09 from <https://modal.com/pricing>. Printed per second: $0.00003942 a physical core (2 vCPU) and $0.00000667 a GiB. (2 x 0.00003942 + 8 x 0.00000667) x 60 = 0.007932. Starter plan runs 100 containers; Docker needs the VM runtime.
- **Blacksmith runner** — read 2026-11-09 from <https://www.blacksmith.sh/pricing>. $0.004 a minute is printed for 2 vCPU and the rate scales with vCPU, so 0.008 here. The 3,000 free minutes are counted at 2 vCPU, so 1,500 here.
- **Depot runner** — read 2026-11-09 from <https://depot.dev/docs/github-actions/runner-types>. $0.012 a minute is printed for depot-ubuntu-24.04-4. The $20 plan includes 2,000 minutes counted at 2 vCPU with a 2x multiplier for this size, so 1,000 here.
- **GitHub-hosted runner (public repository)** — read 2026-11-09 from <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>. "Use of the standard GitHub-hosted runners is free and unlimited on public repositories." 20 jobs at once on the Free plan, 40 on Pro, 60 on Team.
- **GitHub-hosted runner (private repository)** — read 2026-11-09 from <https://docs.github.com/en/billing/reference/actions-runner-pricing>. $0.006 a minute for the 2-core Linux runner, each job rounded up to the minute. Included plan minutes are an account fact and are supplied as allowance state, not here.

<!-- generated:sources:end -->

## Related

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Route table](/HoBo/ci/route-table/) · [FinOps](/HoBo/operations/finops/)
