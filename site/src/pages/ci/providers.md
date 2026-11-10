---
layout: ../../layouts/Docs.astro
title: CI providers
description: "Every runner provider the HoBo CI fleet can price: machine, rate, included minutes, plan fee, limits, who each serves, and how to connect one."
---

# CI providers

The fleet holds a **financial model** for each provider: one machine class, what a minute costs, what is included each month, the plan fee, the limit on jobs at once, and which repositories it serves.

These are **ranking inputs with dated sources**, not billing: published list prices read from each vendor's own page, each with the day it was read. The tables are generated from the models, so they are what the balancer uses.

## What each provider costs

<!-- generated:providers:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Provider | Machine | Reaches a job by | USD per minute | Included each month | Plan fee | Jobs at once | Usable today |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HoBo box worker | 4 vCPU, 16 GB | inject | 0 | — | — | the worker's slots | yes |
| Box of the agent that opened the pull request | 4 vCPU, 8 GB | label | 0 | — | — | 1 | yes, on a local relay |
| Remote actions-runner-controller scale set | 4 vCPU, 16 GB | label | 0 | — | — | the scale set's size | yes, through the bridge |
| Boat CI runner | 4 vCPU, 8 GB | label | 0.0006 (derived) | — | $20.00 | 100 | yes, through the bridge |
| Boat sandbox (API) | 4 vCPU, 8 GB | inject | 0.0006 (derived) | — | $20.00 | 100 | no: modelled only, no host driver |
| Agent37 VM instance | 4 vCPU, 8 GB | inject | 0.000522 (derived) | — | — | 3 | no: modelled only, no host driver |
| Jog runner | 4 vCPU, 16 GB | label | 0.0024 (derived) | 2500 min | — | no published limit | yes, through the bridge |
| Modal Sandbox | 4 vCPU, 8 GB | inject | 0.007932 (derived) | — | — | 100 | no: modelled only, no host driver |
| Blacksmith runner | 4 vCPU, 16 GB | label | 0.008 (derived) | 1500 min | — | no published limit | yes, through the bridge |
| Depot runner | 4 vCPU, 16 GB | label | 0.012 | 1000 min | $20.00 | no published limit | yes, through the bridge |
| GitHub-hosted runner (public repository) | 4 vCPU, 16 GB | label | 0 | — | — | 20 | yes, through the bridge |
| GitHub-hosted runner (private repository) | 2 vCPU, 8 GB | label | 0.006 | — | — | 20 | yes, through the bridge |

<!-- generated:providers:end -->

| Column | Meaning |
|---|---|
| **Reaches a job by** | `inject`: the relay starts the runner. `label`: the job asks for the provider's label. See [HoBo CI](/HoBo/ci/). |
| **(derived)** | The vendor prints no rate for this machine. It was computed from one the vendor does print; the arithmetic is under [Sources](#sources). |
| **Jobs at once** | The provider's own ceiling. Where it publishes none, your policy and budget are the limit. |
| **Usable today** | How a relay can use the provider now; see below. |

### Usable today

| Value | Meaning |
|---|---|
| *yes* | The relay starts runners there directly, for any repository it admits |
| *yes, through the bridge* | Accepted in policy. The relay reaches it through a companion workflow that hosts the runner, and that bridge serves **trusted private repositories only** |
| *yes, on a local relay* | The trusted runner on a workstation, for local environments |
| *no: modelled only* | The fleet can price and rank it, but no host driver exists, so policy does not accept it |

For a **public repository**, that leaves the box as the only provider admission can use today. A label provider can take public-repository jobs once a workflow asks for its label, which is what the [route table](/HoBo/ci/route-table/) prepares and no workflow does yet.

## Who each provider serves

A provider that cannot run a job is never priced for it.

<!-- generated:eligibility:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

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

- **Public repos: opt-in** — served only after the account owner turns that on at the provider.
- **Orgs only** — repositories owned by an organization, not a personal account.
- **Own machine** — each job gets a machine nothing else shares, discarded afterwards. Public repositories and pull requests require it, so a shared cluster or a workstation is never chosen for them.

## How a job is priced

The fleet does not multiply a rate by a duration. Each model becomes a rate card in the pricing engine, which rates the month **with and without** the job. The difference is the job's cost.

<!-- generated:pricing:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

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

- **Included minutes** — a job inside them costs nothing; the first minute past them costs the overage rate.
- **Plan fees** — a fee you already pay is not the job's cost. A plan the job would have to open is, in full. The relay never opens a paid plan on its own.
- **Stale prices** — a price past its expiry is not used, and a provider with no current price is not chosen.

## Connect a provider

Providers are listed in the CI policy file, `.hobo/ci.json`: a `kind`, a connection, and the label a job would ask for. A provider is off until `enabled` is `true`.

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

Jog and Boat are the kinds `jog` and `boat`:

```json
{ "id": "boat", "kind": "boat", "connectionRef": "boat", "runsOn": "boat", "enabled": false }
```

| Rule | Why |
|---|---|
| Upgrade the relay before adding `jog` or `boat` | An older relay rejects the whole policy file at a kind it does not know |
| Never `ubuntu-latest` | A route has to name a concrete machine |

## What a model is not

- Not your invoice: list prices, not negotiated or metered ones.
- Not a live feed: read by hand, dated, and expiring.
- Not free-tier pooling: included minutes are one account's, never shared across tenants.

## Sources

<!-- generated:sources:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

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

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Route table](/HoBo/ci/route-table/) · [FinOps](/HoBo/operations/finops/) · [Metering](/HoBo/reference/metering/)
