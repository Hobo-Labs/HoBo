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
| Daytona sandbox (Linux VM) | 4 vCPU, 8 GB | inject | 0.00552 (derived) | — | — | 62 | no: modelled only, no host driver |
| Daytona sandbox (container) | 4 vCPU, 8 GB | inject | 0.00552 (derived) | — | — | 62 | no: modelled only, no host driver |
| E2B sandbox (Hobby) | 4 vCPU, 8 GB | inject | 0.00552 (derived) | — | — | 10 | no: modelled only, no host driver |
| E2B sandbox (Pro) | 4 vCPU, 8 GB | inject | 0.00552 (derived) | — | $150.00 | 100 | no: modelled only, no host driver |
| Lizard sandbox (API) | 4 vCPU, 8 GB | inject | 0.00054 (derived) | 35185 min | $19.00 | 10 | no: modelled only, no host driver |
| Northflank sandbox | 4 vCPU, 8 GB | inject | 0.002222 (derived) | — | — | no published limit | no: modelled only, no host driver |
| Freestyle VM | 4 vCPU, 8 GB | inject | 0.004408 (derived) | — | — | 10 | no: modelled only, no host driver |
| Blaxel sandbox | 4 vCPU, 8 GB | inject | 0.00552 (derived) | — | — | 10 | no: modelled only, no host driver |
| Runloop Devbox | 4 vCPU, 8 GB | inject | 0.01056 (derived) | — | — | no published limit | no: modelled only, no host driver |
| Blacksmith runner | 4 vCPU, 16 GB | label | 0.008 (derived) | 1500 min | — | no published limit | yes, through the bridge |
| Depot runner | 4 vCPU, 16 GB | label | 0.012 | 1000 min | $20.00 | no published limit | yes, through the bridge |
| Lizard runner | 4 vCPU, 8 GB | label | 0.00054 | 35185 min | $19.00 | no published limit | yes, through the bridge |
| Cloudflare Sandbox | 4 vCPU, 12 GB | inject | 0.0066 (derived) | 93 min | $5.00 | 375 | no: modelled only, no host driver |
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
| Daytona sandbox (Linux VM) | yes | yes | no | yes | yes | yes |
| Daytona sandbox (container) | yes | yes | no | yes | yes | no |
| E2B sandbox (Hobby) | yes | yes | no | yes | yes | yes |
| E2B sandbox (Pro) | yes | yes | no | yes | yes | yes |
| Lizard sandbox (API) | yes | yes | no | no | yes | yes |
| Northflank sandbox | yes | yes | no | no | yes | yes |
| Freestyle VM | yes | yes | no | yes | yes | yes |
| Blaxel sandbox | yes | yes | no | yes | yes | yes |
| Runloop Devbox | yes | yes | no | yes | yes | yes |
| Blacksmith runner | yes | yes | yes | yes | no | yes |
| Depot runner | opt-in | yes | yes | yes | no | yes |
| Lizard runner | yes | yes | yes | yes | no | yes |
| Cloudflare Sandbox | yes | yes | no | yes | yes | yes |
| GitHub-hosted runner (public repository) | yes | no | no | yes | yes | yes |
| GitHub-hosted runner (private repository) | no | yes | no | yes | yes | yes |

<!-- generated:eligibility:end -->

- **Public repos: opt-in** — served only after the account owner turns that on at the provider.
- **Orgs only** — repositories owned by an organization, not a personal account.
- **Own machine** — each job gets a machine nothing else shares, discarded afterwards. Public repositories and pull requests require it, so a shared cluster or a workstation is never chosen for them.

## What each machine can do

A provider's limits are part of its model. A job that asks for more than the machine class has, or that would run longer than the provider lets one machine live, is refused there before it is priced.

<!-- generated:capabilities:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Provider | Kept apart by | Longest run | Largest machine | CPU | Own image | Internet out | Egress allow list | Self-hostable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Daytona sandbox (Linux VM)](https://www.daytona.io/docs/en/sandboxes.md) | own kernel (VM) | no published limit | 4 vCPU, 8 GB | x64 | no | yes | yes | yes |
| [Daytona sandbox (container)](https://www.daytona.io/docs/en/linux-sandboxes.md) | container on a shared kernel | no published limit | 4 vCPU, 8 GB | x64 | yes | yes | yes | yes |
| [E2B sandbox (Hobby)](https://docs.e2b.dev/billing.md) | own kernel (VM) | 60 min | 8 vCPU, 8 GB | x64 | yes | yes | yes | yes |
| [E2B sandbox (Pro)](https://docs.e2b.dev/billing.md) | own kernel (VM) | 24 h | 8 vCPU, 8 GB | x64 | yes | yes | yes | yes |
| [Lizard sandbox (API)](https://lizard.build/docs/platform/limits.md) | own kernel (VM) | 596 h | 8 vCPU, 16 GB | not published | no | yes | no | no |
| [Northflank sandbox](https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas.md) | own kernel (VM) | no published limit | 8 vCPU, 16 GB | not published | yes | no | no | no |
| [Freestyle VM](https://www.freestyle.sh/docs/vms/network/firewall.md) | own kernel (VM) | no published limit | 4 vCPU, 8 GB | not published | no | no | yes | no |
| [Blaxel sandbox](https://docs.blaxel.ai/Sandboxes/Overview.md) | own kernel (VM) | no published limit | not published | not published | yes | no | no | no |
| [Runloop Devbox](https://docs.runloop.ai/docs/devboxes/configuration/sizes.md) | own kernel (VM) | no published limit | 16 vCPU, 64 GB | not published | yes | yes | yes | no |
| [Lizard runner](https://lizard.build/ci) | own kernel (VM) | no published limit | 8 vCPU, 16 GB | x64 | no | yes | no | no |
| [Cloudflare Sandbox](https://developers.cloudflare.com/containers/platform/limits/index.md) | own kernel (VM) | no published limit | 4 vCPU, 12 GB | not published | yes | no | yes | no |

<!-- generated:capabilities:end -->

- **Listed here** are the providers whose limits have been read from the vendor's documentation; each name links to the page. A provider not listed has no recorded limit, and none is assumed.
- **Kept apart by** — what separates one job's machine from the provider's other tenants. Only a machine with its own kernel counts as an *own machine* above.
- **Longest run** — a job whose reserved minutes exceed it is refused with `fleet.runtime`.
- **Largest machine** — the most one job can be given there. The fleet prices the 4 vCPU class; a job that states a larger need is refused with `fleet.machine`.
- **Own image, Internet out, Egress allow list, Self-hostable** — *yes* only where the vendor documents it. *No* covers both "documented as absent" and "not stated".

### Looked at and not modelled

| Provider | Why it has no model |
|---|---|
| Fly.io Sprites | Every Sprite has 8 vCPU and is billed on the CPU and memory it actually uses, so there is no machine class to price |
| Beam | A sandbox is a container by default and a microVM on request; which price tier the microVM bills at is not printed |
| Morph Cloud | Billed in its own compute unit, and its plan pages disagree on what is included |
| Koyeb Sandboxes | In public preview, with no 4 vCPU / 8 GB instance: 4 vCPU comes with 4 GB and 8 GB with 8 vCPU |
| CodeSandbox SDK | Deprecated by its vendor; the successor publishes no prices |

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
| Daytona sandbox (Linux VM) | $0.1104 | — | — |
| Daytona sandbox (container) | $0.1104 | — | — |
| E2B sandbox (Hobby) | $0.1104 | — | — |
| E2B sandbox (Pro) | $0.1104 | — | $150.1104 |
| Lizard sandbox (API) | $0 | $0.0108 | $19 |
| Northflank sandbox | $0.04444 | — | — |
| Freestyle VM | $0.08816 | — | — |
| Blaxel sandbox | $0.1104 | — | — |
| Runloop Devbox | $0.2112 | — | — |
| Blacksmith runner | $0 | $0.16 | — |
| Depot runner | $0 | $0.24 | $20 |
| Lizard runner | $0 | $0.0108 | $19 |
| Cloudflare Sandbox | $0 | $0.132 | $5 |
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

Jog, Boat and Lizard are the kinds `jog`, `boat` and `lizard`:

```json
{ "id": "boat", "kind": "boat", "connectionRef": "boat", "runsOn": "boat", "enabled": false }
```

```json
{ "id": "lizard", "kind": "lizard", "connectionRef": "lizard", "runsOn": "lizard-medium-ubuntu-2404", "enabled": false }
```

| Rule | Why |
|---|---|
| Upgrade the relay before adding `jog`, `boat` or `lizard` | An older relay rejects the whole policy file at a kind it does not know |
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
- **Daytona sandbox (Linux VM)** — read 2026-11-10 from <https://www.daytona.io/pricing>. Printed per hour: $0.0504 a vCPU and $0.0162 a GiB, billed per second. (4 x 0.0504 + 8 x 0.0162) / 60 = 0.00552. 4 vCPU / 8 GB is the largest Linux sandbox. Modelled at Tier 3 ($500 top-up): 250 vCPU at once, and the first tier whose outbound network is open. The VM class takes no Dockerfile. No maximum runtime is published; auto-stop has to be turned off. Running the Actions runner there is untested.
- **Daytona sandbox (container)** — read 2026-11-10 from <https://www.daytona.io/pricing>. Same rates and tier as the Linux VM class. The default class: a container that shares the host's kernel, started from an image or Dockerfile, with Docker-in-Docker documented. It is not a machine of its own, so it is never chosen for a public repository or a pull request.
- **E2B sandbox (Hobby)** — read 2026-11-10 from <https://e2b.dev/pricing>. Printed per second: $0.000014 a vCPU and $0.0000045 a GiB. (4 x 0.000014 + 8 x 0.0000045) x 60 = 0.00552. Hobby: no fee, 10 sandboxes at once, one hour a sandbox. The $100 credit is one-time, so it is not an included allowance here. The pricing page lists custom CPU and RAM under Pro only while the billing page gives Hobby an 8 vCPU ceiling, so this size on Hobby is unconfirmed. Running the Actions runner there is untested.
- **E2B sandbox (Pro)** — read 2026-11-10 from <https://e2b.dev/pricing>. Same rates as Hobby. Pro: $150 a month, 100 sandboxes at once, 24 hours a sandbox. More than 8 GiB is by request to the vendor. Running the Actions runner there is untested.
- **Lizard sandbox (API)** — read 2026-11-10 from <https://lizard.build/docs/platform/limits.md>. Printed as $0.0324 an hour for the medium size (4 vCPU / 8 GB); 0.0324 / 60 = 0.00054. Pro ($19 a month, with $19 of usage included) runs 40 vCPU of sandboxes at once, so 10 of this size. A sandbox stops after 596 hours, and a command run through exec after 600 seconds, so a runner has to be started detached. Docker inside a sandbox and its CPU architecture are not published. Running the Actions runner there is untested.
- **Northflank sandbox** — read 2026-11-10 from <https://northflank.com/pricing>. Printed per hour, billed by the second: $0.01667 a vCPU and $0.00833 a GB. The nf-compute-400 plan is 4 vCPU / 8192 MiB: (4 x 0.01667 + 8 x 0.00833) / 60 = 0.002222. The default quota allows 8 vCPU and 16 GiB an instance. Sandboxes are microVMs for CPU workloads. Docker inside one, outbound network and a limit on sandboxes at once are not stated. Running the Actions runner there is untested.
- **Freestyle VM** — read 2026-11-10 from <https://www.freestyle.sh/pricing>. Printed per hour, metered per second: $0.04032 a vCPU and $0.0129 a GiB. (4 x 0.04032 + 8 x 0.0129) / 60 = 0.004408. The free plan runs 10 VMs at once of at most 4 vCPU / 8 GiB; Hobby ($50 a month) 40 of 8 / 16; Pro ($500) 400 of 32 / 64. MicroVMs with a full kernel, so Docker runs natively. A VM has no outbound network until its firewall allows it, which a runner needs. Running the Actions runner there is untested.
- **Blaxel sandbox** — read 2026-11-10 from <https://blaxel.ai/pricing>. Billed on memory alone: "$0.0000115 / GB RAM · second", and "a sandbox with 8 GB memory is allocated 4 CPU cores". 8 x 0.0000115 x 60 = 0.00552. The free tier's sandbox limit is 10 (50 at $20 a month, 200 at $50), and standby sandboxes count toward it. MicroVMs; a docker-in-sandbox image is documented. Outbound network and a largest self-serve machine are not stated. Running the Actions runner there is untested.
- **Runloop Devbox** — read 2026-11-10 from <https://runloop.ai/pricing>. Printed per second: "$0.00003 / CPU-sec" and "$0.000007 / GB-sec". (4 x 0.00003 + 8 x 0.000007) x 60 = 0.01056. Basic is free plus usage and Pro is $250 a month plus usage; which plan a custom 4 CPU size needs is not printed, so no fee is modelled. A trial account runs 3 devboxes at once; no limit is printed after it. A micro-VM around a container, with Docker-in-Docker blueprints and unrestricted network by default. Running the Actions runner there is untested.
- **Blacksmith runner** — read 2026-11-09 from <https://www.blacksmith.sh/pricing>. $0.004 a minute is printed for 2 vCPU and the rate scales with vCPU, so 0.008 here. The 3,000 free minutes are counted at 2 vCPU, so 1,500 here.
- **Depot runner** — read 2026-11-09 from <https://depot.dev/docs/github-actions/runner-types>. $0.012 a minute is printed for depot-ubuntu-24.04-4. The $20 plan includes 2,000 minutes counted at 2 vCPU with a 2x multiplier for this size, so 1,000 here.
- **Lizard runner** — read 2026-11-10 from <https://lizard.build/ci>. $0.00054 a minute is printed for the medium runner, billed by the second. The $19 Pro plan "includes usage equal to its price each month": 19 / 0.00054 = 35,185 minutes. Organizations only. Public repositories are read from "keeps a cache disk only for private repositories", which is not an outright statement. "Jobs from forks start on an empty disk" is all that is said about forks, so they are not routed there. The vendor's action READMEs write the label as lizard-4vcpu-ubuntu-2404 instead. No limit on jobs at once is published.
- **Cloudflare Sandbox** — read 2026-11-10 from <https://developers.cloudflare.com/containers/pricing/>. The standard-4 instance, 4 vCPU / 12 GiB and the largest there is. Printed per second: $0.000020 a vCPU and $0.0000025 a GiB; CPU is charged for active use only, so (4 x 0.00002 + 12 x 0.0000025) x 60 = 0.0066 is the ceiling. The $5 Workers Paid plan includes 375 vCPU-minutes, 93 minutes of this class. 1,500 vCPU at once an account, so 375. Each instance is a Firecracker microVM that is never stopped for running too long, and a Docker-in-Docker guide exists. One page says internet access is on by default and another that it is off. This is not the `cloudflare` policy kind, which is the Cloudflare CI pipeline backend. Running the Actions runner there is untested.
- **GitHub-hosted runner (public repository)** — read 2026-11-09 from <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>. "Use of the standard GitHub-hosted runners is free and unlimited on public repositories." 20 jobs at once on the Free plan, 40 on Pro, 60 on Team.
- **GitHub-hosted runner (private repository)** — read 2026-11-09 from <https://docs.github.com/en/billing/reference/actions-runner-pricing>. $0.006 a minute for the 2-core Linux runner, each job rounded up to the minute. Included plan minutes are an account fact and are supplied as allowance state, not here.

<!-- generated:sources:end -->

## Related

[Fleet balancing](/HoBo/ci/fleet-balancing/) · [Route table](/HoBo/ci/route-table/) · [FinOps](/HoBo/operations/finops/) · [Metering](/HoBo/reference/metering/)
