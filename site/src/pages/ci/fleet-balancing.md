---
layout: ../../layouts/Docs.astro
title: Fleet balancing
description: "How HoBo CI picks a runner provider for a job: eligibility, price ranked by the Dispatcher, then the budget policy, shown on worked decisions."
---

# Fleet balancing

Given a job and the providers an account has connected, the balancer returns **every provider that could take the job, best first**, and a **coded reason** for each one that could not. Nothing is chosen silently.

## Same path as placement

| Step | Question | Decided by |
|---|---|---|
| Eligibility | Can this provider run the job at all? | Visibility, ownership, Docker, forks, isolation, health, free slots, and whether the queued label can still reach it |
| Price | What does the job add to this month's bill? | The pricing engine, ranked by the [Dispatcher](/HoBo/reference/packages/) |
| Policy | Is that cost allowed? | The budget policy, with the same measurements CI admission uses |

The three are asked in order and never merged: a provider that cannot run the job is not priced, and a price is not an admission.

## Tiers come before price

A cheaper provider in a later tier never jumps the queue.

| Tier | Meaning | Default members |
|---|---|---|
| `primary` | Capacity you already pay for | The box, an agent's own box |
| `overflow` | Rented capacity, ranked by price | A remote ARC scale set, Boat, Agent37, Jog, Modal, Blacksmith, Depot |
| `last-resort` | Considered only when nothing else is admitted | GitHub-hosted runners |

GitHub-hosted runners are last by default even on a public repository, where they are free. Policy can move a provider to another tier. Providers that cost the same keep the order they were listed in.

## Worked decisions

Each table is the balancer's **real output** for a 20-minute job: the whole catalog connected, a three-slot box, every paid plan already open. They are regenerated from the code.

### A pull request while the box has room

A pull request on a public, organization-owned repository. The box is first because it is already paid for; everything after it is what the job would fall to.

<!-- generated:box-free:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Rank | Member | Tier | Job asks for | Adds to the bill |
| --- | --- | --- | --- | --- |
| 1 | HoBo box worker | primary | `hobo` | $0 |
| 2 | Blacksmith runner | overflow | `blacksmith-4vcpu-ubuntu-2404` | $0 (included minutes) |
| 3 | Lizard runner | overflow | `lizard-medium-ubuntu-2404` | $0 (included minutes) |
| 4 | Cloudflare Sandbox | overflow | `hobo` | $0 (included minutes) |
| 5 | Agent37 VM instance | overflow | `hobo` | $0.01044 |
| 6 | Boat sandbox (API) | overflow | `hobo` | $0.012 |
| 7 | Freestyle VM | overflow | `hobo` | $0.08816 |
| 8 | Daytona sandbox (Linux VM) | overflow | `hobo` | $0.1104 |
| 9 | E2B sandbox (Hobby) | overflow | `hobo` | $0.1104 |
| 10 | E2B sandbox (Pro) | overflow | `hobo` | $0.1104 |
| 11 | Blaxel sandbox | overflow | `hobo` | $0.1104 |
| 12 | Modal Sandbox | overflow | `hobo` | $0.15864 |
| 13 | Runloop Devbox | overflow | `hobo` | $0.2112 |
| 14 | GitHub-hosted runner (public repository) | last-resort | `ubuntu-24.04` | $0 |

| Not chosen | Code | Why |
| --- | --- | --- |
| Box of the agent that opened the pull request | `fleet.docker` | member has no Docker daemon |
| Remote actions-runner-controller scale set | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Boat CI runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| Jog runner | `fleet.visibility` | provider does not serve public repositories |
| Daytona sandbox (container) | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Lizard sandbox (API) | `fleet.docker` | member has no Docker daemon |
| Northflank sandbox | `fleet.docker` | member has no Docker daemon |
| Depot runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| GitHub-hosted runner (private repository) | `fleet.visibility` | provider does not serve public repositories |

<!-- generated:box-free:end -->

### The same pull request, box full

The box drops out with `fleet.capacity`. The cheapest rented provider that may serve a public repository takes the job: Blacksmith, because the job fits inside its included minutes.

<!-- generated:box-full:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Rank | Member | Tier | Job asks for | Adds to the bill |
| --- | --- | --- | --- | --- |
| 1 | Blacksmith runner | overflow | `blacksmith-4vcpu-ubuntu-2404` | $0 (included minutes) |
| 2 | Lizard runner | overflow | `lizard-medium-ubuntu-2404` | $0 (included minutes) |
| 3 | Cloudflare Sandbox | overflow | `hobo` | $0 (included minutes) |
| 4 | Agent37 VM instance | overflow | `hobo` | $0.01044 |
| 5 | Boat sandbox (API) | overflow | `hobo` | $0.012 |
| 6 | Freestyle VM | overflow | `hobo` | $0.08816 |
| 7 | Daytona sandbox (Linux VM) | overflow | `hobo` | $0.1104 |
| 8 | E2B sandbox (Hobby) | overflow | `hobo` | $0.1104 |
| 9 | E2B sandbox (Pro) | overflow | `hobo` | $0.1104 |
| 10 | Blaxel sandbox | overflow | `hobo` | $0.1104 |
| 11 | Modal Sandbox | overflow | `hobo` | $0.15864 |
| 12 | Runloop Devbox | overflow | `hobo` | $0.2112 |
| 13 | GitHub-hosted runner (public repository) | last-resort | `ubuntu-24.04` | $0 |

| Not chosen | Code | Why |
| --- | --- | --- |
| HoBo box worker | `fleet.capacity` | all 3 slots are in use |
| Box of the agent that opened the pull request | `fleet.docker` | member has no Docker daemon |
| Remote actions-runner-controller scale set | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Boat CI runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| Jog runner | `fleet.visibility` | provider does not serve public repositories |
| Daytona sandbox (container) | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Lizard sandbox (API) | `fleet.docker` | member has no Docker daemon |
| Northflank sandbox | `fleet.docker` | member has no Docker daemon |
| Depot runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| GitHub-hosted runner (private repository) | `fleet.visibility` | provider does not serve public repositories |

<!-- generated:box-full:end -->

### A push to main on a private repository, box full

A private repository's trunk job does not need its own machine, so the shared ARC cluster is allowed, and wins: rented-tier capacity that adds nothing to the bill.

<!-- generated:private-trunk:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Rank | Member | Tier | Job asks for | Adds to the bill |
| --- | --- | --- | --- | --- |
| 1 | Remote actions-runner-controller scale set | overflow | `hobo-arc` | $0 |
| 2 | Jog runner | overflow | `jog-4vcpu` | $0 (included minutes) |
| 3 | Blacksmith runner | overflow | `blacksmith-4vcpu-ubuntu-2404` | $0 (included minutes) |
| 4 | Depot runner | overflow | `depot-ubuntu-24.04-4` | $0 (included minutes) |
| 5 | Lizard runner | overflow | `lizard-medium-ubuntu-2404` | $0 (included minutes) |
| 6 | Cloudflare Sandbox | overflow | `hobo` | $0 (included minutes) |
| 7 | Agent37 VM instance | overflow | `hobo` | $0.01044 |
| 8 | Boat CI runner | overflow | `boat` | $0.012 |
| 9 | Boat sandbox (API) | overflow | `hobo` | $0.012 |
| 10 | Freestyle VM | overflow | `hobo` | $0.08816 |
| 11 | Daytona sandbox (Linux VM) | overflow | `hobo` | $0.1104 |
| 12 | Daytona sandbox (container) | overflow | `hobo` | $0.1104 |
| 13 | E2B sandbox (Hobby) | overflow | `hobo` | $0.1104 |
| 14 | E2B sandbox (Pro) | overflow | `hobo` | $0.1104 |
| 15 | Blaxel sandbox | overflow | `hobo` | $0.1104 |
| 16 | Modal Sandbox | overflow | `hobo` | $0.15864 |
| 17 | Runloop Devbox | overflow | `hobo` | $0.2112 |
| 18 | GitHub-hosted runner (private repository) | last-resort | `ubuntu-24.04` | $0.12 |

| Not chosen | Code | Why |
| --- | --- | --- |
| HoBo box worker | `fleet.capacity` | all 3 slots are in use |
| Box of the agent that opened the pull request | `fleet.docker` | member has no Docker daemon |
| Lizard sandbox (API) | `fleet.docker` | member has no Docker daemon |
| Northflank sandbox | `fleet.docker` | member has no Docker daemon |
| GitHub-hosted runner (public repository) | `fleet.visibility` | this machine class serves public repositories only |

<!-- generated:private-trunk:end -->

### A job that is already waiting

The job is queued on the label `hobo`. A queued job cannot change its label, so every label provider is out with `fleet.label-bound`; only injected capacity can still reach it.

<!-- generated:queued:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Rank | Member | Tier | Job asks for | Adds to the bill |
| --- | --- | --- | --- | --- |
| 1 | Cloudflare Sandbox | overflow | `hobo` | $0 (included minutes) |
| 2 | Agent37 VM instance | overflow | `hobo` | $0.01044 |
| 3 | Boat sandbox (API) | overflow | `hobo` | $0.012 |
| 4 | Freestyle VM | overflow | `hobo` | $0.08816 |
| 5 | Daytona sandbox (Linux VM) | overflow | `hobo` | $0.1104 |
| 6 | E2B sandbox (Hobby) | overflow | `hobo` | $0.1104 |
| 7 | E2B sandbox (Pro) | overflow | `hobo` | $0.1104 |
| 8 | Blaxel sandbox | overflow | `hobo` | $0.1104 |
| 9 | Modal Sandbox | overflow | `hobo` | $0.15864 |
| 10 | Runloop Devbox | overflow | `hobo` | $0.2112 |

| Not chosen | Code | Why |
| --- | --- | --- |
| HoBo box worker | `fleet.capacity` | all 3 slots are in use |
| Box of the agent that opened the pull request | `fleet.label-bound` | job is already queued on hobo; this member serves hobo-local-host |
| Remote actions-runner-controller scale set | `fleet.label-bound` | job is already queued on hobo; this member serves hobo-arc |
| Boat CI runner | `fleet.label-bound` | job is already queued on hobo; this member serves boat |
| Jog runner | `fleet.label-bound` | job is already queued on hobo; this member serves jog-4vcpu |
| Daytona sandbox (container) | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Lizard sandbox (API) | `fleet.docker` | member has no Docker daemon |
| Northflank sandbox | `fleet.docker` | member has no Docker daemon |
| Blacksmith runner | `fleet.label-bound` | job is already queued on hobo; this member serves blacksmith-4vcpu-ubuntu-2404 |
| Depot runner | `fleet.label-bound` | job is already queued on hobo; this member serves depot-ubuntu-24.04-4 |
| Lizard runner | `fleet.label-bound` | job is already queued on hobo; this member serves lizard-medium-ubuntu-2404 |
| GitHub-hosted runner (public repository) | `fleet.label-bound` | job is already queued on hobo; this member serves ubuntu-24.04 |
| GitHub-hosted runner (private repository) | `fleet.label-bound` | job is already queued on hobo; this member serves ubuntu-24.04 |

<!-- generated:queued:end -->

### The budget is spent

A $5 budget with $5 committed. Every provider that would add to the bill is refused by the budget policy, and the job falls through to capacity that costs nothing.

<!-- generated:budget-spent:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Rank | Member | Tier | Job asks for | Adds to the bill |
| --- | --- | --- | --- | --- |
| 1 | Blacksmith runner | overflow | `blacksmith-4vcpu-ubuntu-2404` | $0 (included minutes) |
| 2 | Lizard runner | overflow | `lizard-medium-ubuntu-2404` | $0 (included minutes) |
| 3 | Cloudflare Sandbox | overflow | `hobo` | $0 (included minutes) |
| 4 | GitHub-hosted runner (public repository) | last-resort | `ubuntu-24.04` | $0 |

| Not chosen | Code | Why |
| --- | --- | --- |
| HoBo box worker | `fleet.capacity` | all 3 slots are in use |
| Box of the agent that opened the pull request | `fleet.docker` | member has no Docker daemon |
| Remote actions-runner-controller scale set | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Boat CI runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| Jog runner | `fleet.visibility` | provider does not serve public repositories |
| Daytona sandbox (container) | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Lizard sandbox (API) | `fleet.docker` | member has no Docker daemon |
| Northflank sandbox | `fleet.docker` | member has no Docker daemon |
| Depot runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| GitHub-hosted runner (private repository) | `fleet.visibility` | provider does not serve public repositories |
| Agent37 VM instance | `budget.policy.exhausted` | projected commitments exceed the budget |
| Boat sandbox (API) | `budget.policy.exhausted` | projected commitments exceed the budget |
| Freestyle VM | `budget.policy.exhausted` | projected commitments exceed the budget |
| Blaxel sandbox | `budget.policy.exhausted` | projected commitments exceed the budget |
| Daytona sandbox (Linux VM) | `budget.policy.exhausted` | projected commitments exceed the budget |
| E2B sandbox (Hobby) | `budget.policy.exhausted` | projected commitments exceed the budget |
| E2B sandbox (Pro) | `budget.policy.exhausted` | projected commitments exceed the budget |
| Modal Sandbox | `budget.policy.exhausted` | projected commitments exceed the budget |
| Runloop Devbox | `budget.policy.exhausted` | projected commitments exceed the budget |

<!-- generated:budget-spent:end -->

### The box is short of a resource

The box has free slots, but its [host health](/HoBo/ci/host-health/) is critical. It is skipped with `fleet.unhealthy`.

<!-- generated:box-unhealthy:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Rank | Member | Tier | Job asks for | Adds to the bill |
| --- | --- | --- | --- | --- |
| 1 | Blacksmith runner | overflow | `blacksmith-4vcpu-ubuntu-2404` | $0 (included minutes) |
| 2 | Lizard runner | overflow | `lizard-medium-ubuntu-2404` | $0 (included minutes) |
| 3 | Cloudflare Sandbox | overflow | `hobo` | $0 (included minutes) |
| 4 | Agent37 VM instance | overflow | `hobo` | $0.01044 |
| 5 | Boat sandbox (API) | overflow | `hobo` | $0.012 |
| 6 | Freestyle VM | overflow | `hobo` | $0.08816 |
| 7 | Daytona sandbox (Linux VM) | overflow | `hobo` | $0.1104 |
| 8 | E2B sandbox (Hobby) | overflow | `hobo` | $0.1104 |
| 9 | E2B sandbox (Pro) | overflow | `hobo` | $0.1104 |
| 10 | Blaxel sandbox | overflow | `hobo` | $0.1104 |
| 11 | Modal Sandbox | overflow | `hobo` | $0.15864 |
| 12 | Runloop Devbox | overflow | `hobo` | $0.2112 |
| 13 | GitHub-hosted runner (public repository) | last-resort | `ubuntu-24.04` | $0 |

| Not chosen | Code | Why |
| --- | --- | --- |
| HoBo box worker | `fleet.unhealthy` | member's circuit breaker is open |
| Box of the agent that opened the pull request | `fleet.docker` | member has no Docker daemon |
| Remote actions-runner-controller scale set | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Boat CI runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| Jog runner | `fleet.visibility` | provider does not serve public repositories |
| Daytona sandbox (container) | `fleet.isolation` | job requires a machine nothing else shares; this member is shared |
| Lizard sandbox (API) | `fleet.docker` | member has no Docker daemon |
| Northflank sandbox | `fleet.docker` | member has no Docker daemon |
| Depot runner | `fleet.visibility` | public repositories are off at this provider until the owner turns them on |
| GitHub-hosted runner (private repository) | `fleet.visibility` | provider does not serve public repositories |

<!-- generated:box-unhealthy:end -->

## Refusal codes

Three families, all stable. The full list with retry guidance is in [Errors & codes](/HoBo/reference/errors/#ci-fleet).

| Family | Raised by | Example |
|---|---|---|
| `fleet.` | The fleet's own eligibility and ceilings | `fleet.capacity` |
| `pricing.` | The pricing engine, with its own code after the prefix | an expired rate |
| `budget.` | The budget policy, with its own code after the prefix | `budget.policy.exhausted` |

## Call it yourself

The balancer is a pure function in `@hobo/ci`: no I/O, no clock.

```ts
import {
  balanceFleet,
  fleetAccountExposure,
  fleetBudgetPolicy,
  fleetMembersFromAccount,
} from "@hobo/ci";

const decision = balanceFleet({
  members: fleetMembersFromAccount(account, leases, { poolLabel: "hobo" }),
  demand: {
    id: "acme/app:1001:1:1",
    minutes: 20,
    repository: { visibility: "public", ownerType: "organization" },
    forkPullRequest: false,
    needsDocker: true,
    isolationRequired: true,
  },
  policy: fleetBudgetPolicy(account),
  ...fleetAccountExposure(account, leases),
  now: new Date().toISOString(),
  allowNewProviderAgreements: false,
});

decision.selected; // the best admitted provider, or undefined: the job waits
decision.ranking; // every admitted provider, best first
decision.refusals; // [{ memberId, code, reason }]
```

`fleetMembersFromAccount` builds the fleet from the offers an account really has. The **offer** supplies what was observed for that account: rate, included minutes, ceiling. The **model** supplies what does not vary by account: rounding, plan fee, eligibility, tier.

## What balancing is not

- Not admission of a queued job: a job already waiting on `hobo` is still admitted in the existing box → ARC → GitHub order. The balancer decides ahead of the queue.
- Not a launcher: Agent37, Modal and Boat sandboxes appear in these decisions because they are modelled, but no host driver starts a runner on them yet.
- Not a health monitor for rented providers: only the box reports its health.
- Not a way to open paid plans: placing a job never subscribes to anything unless policy allows it.

## Related

[Providers](/HoBo/ci/providers/) · [Route table](/HoBo/ci/route-table/) · [Host health](/HoBo/ci/host-health/) · [Continuous migration](/HoBo/cicd/migration/)
