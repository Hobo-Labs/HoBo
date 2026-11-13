---
type: Design
title: "CI fleet balancing"
description: "How the HoBo CI relay balances jobs across owned and rented runner providers: per-provider financial models rated by the pricing engine, admission through the shared budget policy, and a published route table for label providers."
tags: [hobo, ci, finops, fleet, design]
---

# CI fleet balancing

HoBo CI started with one host, the box. When more work arrives than the box has
slots, jobs wait on the `hobo` label, and a job that waits long enough is
cancelled by whatever is watching the queue. The relay could already spill to an
ARC scale set and then to GitHub-hosted runners, in that fixed order, when an
operator enabled them. This document describes the general form: any number of
providers, compared on what a job would really cost there, admitted by the same
[shared budget policy](./shared-budget-policy.md) that governs CI admission.

The code is the `fleet` module of `@hobo/ci`
([`packages/ci/src/fleet/`](../../packages/ci/src/fleet/)) and the route
publisher in `@hobo/ci-gh-actions`
([`fleet-routes.ts`](../../packages/ci-gh-actions/src/fleet-routes.ts)).
Operator steps are in the
[runner queue guide](../../packages/ci/RUNNER-QUEUE.md).

## Two ways capacity reaches a job

GitHub matches a job to a runner by label and fixes `runs-on` when the job is
queued. That splits every provider into one of two kinds.

| Binding | How the job gets a runner | Providers |
| --- | --- | --- |
| **Inject** | The job stays on `hobo`. The relay starts a one-shot runner with that label on compute it controls. | Box worker, Vercel Sandbox, Kubernetes isolated pods; the sandbox providers (Boat, Daytona, E2B, Lizard, Northflank, Freestyle, Blaxel, Cloudflare Sandbox, Runloop, Agent37 and Modal) once they have a host driver |
| **Label** | The provider's GitHub App brings the runner. The job must ask for the provider's label before it is queued. | GitHub-hosted, Blacksmith, Depot, Jog, Boat CI, Lizard runners, a remote ARC scale set, the trusted runner on an agent's own box |

Injected capacity is the only kind that can rescue a job that is already
waiting. Label capacity has to be chosen ahead of the queue, so the relay
publishes its choice where a workflow can read it without running anything.

## Financial models

[`models.ts`](../../packages/ci/src/fleet/models.ts) holds one model per
machine class per provider: the rate per runner minute, whether the provider
rounds each job up to a minute, the plan fee, the minutes included each month,
the provider's own ceiling on jobs at once, and which repositories it serves.
Each model names the page its numbers were read from and the day they were read.

A model can also carry the machine's documented **capabilities**: what keeps
one job apart from the provider's other tenants (its own kernel, a user-space
kernel, or a kernel shared with other containers), the longest one machine may
run, the largest machine one job can have, the CPU architectures, and whether
the vendor documents an operator-supplied image, outbound internet, an egress
allow list and self-hosting. Each names the vendor page it was read from. A
flag is true only where the vendor documents the ability, and an absent limit
means none is published, never that there is none. The providers read on
2026-11-10 carry them (Daytona, E2B, Lizard, Northflank, Freestyle, Blaxel,
Cloudflare Sandbox and Runloop); a model without them has no recorded limit.
A figure the vendor does not print for that machine class is marked `derived`
with its arithmetic, and a model past its `validUntil` is refused by the quote
engine, which takes the provider out of rotation instead of trusting a stale
price.

Rates below are for the 4 vCPU class, read on 2026-11-09; the rows from Lizard
to Runloop were read on 2026-11-10.

| Provider | Binding | USD per minute | Included each month | Plan fee | Limits that matter |
| --- | --- | --- | --- | --- | --- |
| Box worker | Inject | 0 | — | — | `HOBO_CI_WORKER_SLOTS` |
| Agent's own box | Label | 0 | — | — | One job; no Docker; no fork jobs |
| Remote ARC scale set | Label | 0 | — | — | The scale set's `maxRunners` |
| Agent37 VM | Inject | 0.000522 (derived) | — | — | 3 instances until the wallet is topped up |
| Boat | Label or inject | 0.0006 (derived) | — | $20 | Public repositories are opt-in; 100 sandboxes |
| Jog | Label | 0.0024 | 2,500 minutes | — | No public repositories |
| Modal Sandbox | Inject | 0.007932 (derived) | — | — | 100 containers on Starter |
| Lizard | Label or inject | 0.00054 | 35,185 minutes | $19 | Runners serve organizations only; Docker inside a sandbox is not documented |
| Northflank sandbox | Inject | 0.002222 (derived) | — | — | Docker inside a sandbox and outbound network are not stated |
| Freestyle VM | Inject | 0.004408 (derived) | — | — | 10 VMs of at most 4 vCPU / 8 GiB on the free plan; no outbound network until the firewall allows it |
| Daytona sandbox | Inject | 0.00552 (derived) | — | — | 4 vCPU / 8 GB is the largest Linux machine; the default class is a container on a shared kernel |
| E2B sandbox | Inject | 0.00552 (derived) | — | — on Hobby, $150 on Pro | One hour a sandbox on Hobby, 24 on Pro |
| Blaxel sandbox | Inject | 0.00552 (derived) | — | — | Billed on memory alone; a sandbox limit of 10 on the free tier |
| Cloudflare Sandbox | Inject | 0.0066 (derived, a ceiling) | 93 minutes | $5 | 4 vCPU / 12 GiB is the largest instance; never stopped for running too long |
| Runloop Devbox | Inject | 0.01056 (derived) | — | — | The plan a 4 CPU size needs is not printed |
| Blacksmith | Label | 0.008 (derived) | 1,500 minutes | — | Organizations only |
| Depot | Label | 0.012 | 1,000 minutes | $20 | Organizations only; public repositories are opt-in |
| GitHub-hosted, public repository | Label | 0 | — | — | 20 jobs at once on the Free plan |
| GitHub-hosted, private repository | Label | 0.006 | account fact | — | Each job rounded up to a minute |

The fleet never multiplies a rate by a duration.
[`pricing.ts`](../../packages/ci/src/fleet/pricing.ts) compiles a model into an
`@hobo/pricing` catalog: a product with a runner-minute meter, a rate card with
the usage charge and the plan fee as a fixed monthly charge, and an allowance
grant for the included minutes. The quote engine rates the month with and
without the job, and the difference is the job's cost. Three consequences fall
out of that without special cases:

- a job inside the included minutes costs nothing, and the first minute past
  them costs the overage rate;
- a plan fee already being paid is not the job's cost, and a plan the job would
  have to open is, in full;
- a provider with no current evidence has no price and is not chosen.

## Balancing

[`balanceFleet`](../../packages/ci/src/fleet/balance.ts) asks three questions
in order and never merges them.

1. **Can this member run the job at all?** Repository visibility and ownership,
   Docker, forks, whether the job needs a machine nothing else shares, whether
   the machine class is large enough for what the job says it needs, whether
   the provider lets one machine run for as long as the job reserves, the
   member's circuit breaker, its free slots, and whether the label the job is
   queued on can still reach it. A refusal here carries a
   code such as `fleet.capacity`, `fleet.visibility`, `fleet.machine` or
   `fleet.runtime`.
2. **What does the job cost there?** Dispatcher v2 rates every remaining member
   through the pricing engine and ranks them by incremental billed amount. A
   pricing rejection carries the engine's code behind a `pricing.` prefix.
3. **Does the budget policy allow that cost?** Every ranked member goes through
   `evaluateBudgetPolicy` with the measurements CI admission supplies:
   `work.cost`, `work.duration`, `work.concurrent`, `provider.cost` for each
   payer, and `ci.attempts` and `ci.queue.duration` when known. A refusal
   carries the policy's own code, such as `budget.policy.exhausted`.

Two ceilings that admission applies outside the policy are applied here too: the
operator's own ceiling on each payer, and the account's legacy ceiling, which
intersects an authored policy's limit. As in admission, a payer or account
already past its ceiling takes no more work, free or not.

Isolation follows admission's rule. A public repository's jobs and every pull
request must run on a machine nothing else shares, so a shared ARC cluster or an
agent's workstation is refused for them with `fleet.isolation`, however cheap it
is.

Roles order the result. `primary` is capacity that is already paid for,
`overflow` is rented capacity ranked by price, and `last-resort` is considered
only when nothing else is admitted. GitHub-hosted runners are `last-resort` by
default, even on a public repository where they are free; policy can promote a
member out of its default tier. Under the `maximize-credits` objective included
minutes are spent before money. Members that cost the same keep the order the
operator authored them in.

An account without an authored budget policy still goes through the same
evaluator, under a policy that says exactly what its legacy ceiling said: one
budget and no other constraint.

## The route table

After each dispatch pass the relay builds the fleet from the account's
connected offers and its leases, balances three representative jobs, and writes
the result to the repository variable `HOBO_CI_FLEET_ROUTES`:

```json
{"fork":"hobo","pr":"ubuntu-24.04","trunk":"hobo-trunk"}
```

The pass writes no other repository variable. A free-slot record it once
published beside the table, and the mesh's routing snapshot, are retired
([ADR-0180, Retirement](./adr/fleet-verdict.md#adr-0180-retirement)):
judging raw capacity in a workflow repeats, outside the relay, a decision only
the relay can make
([finding 146](../ci/findings/0146-route-job-read-a-capacity-record-no-worker-wrote.md)).
The **Route runners** job reads neither that record nor this table. It asks the
relay instead for a fleet verdict: which fleet labels new work should stay off
right now ([ADR-0180](./adr/fleet-verdict.md#adr-0180)). Dispatch still counts
free slots on the box and the rest of the mesh for its own trunk defer, but
`@hobo/ci` no longer defines the published record or its CUE shape: the only
fleet record a repository variable carries is `#FleetRoutes`.

A class whose best member is injected, or that has no admitted member, keeps
the label it has today, because that is where injected capacity can still come
to it.
A write happens only when the value changes, changes are spaced at least a
minute apart so the label cannot flap with every freed slot, and a refused or
failed write is logged and never disturbs admission. Publishing is off unless
the box daemon runs with `HOBO_CI_FLEET_ROUTES=1`, and the GitHub App needs
repository **Variables: write**.

The table is computed at most every fifteen seconds per repository, and a
failed lookup waits the same interval, so the two-second dispatch pass neither
re-rates the fleet nor retries GitHub on every tick. The published value is
constrained by `#FleetRoutes` in `packages/ci/data-models/ci.cue`, and the
repository read and variable writes are in the GitHub App consumer contract.

The rate, included minutes and ceiling of each member come from the connected
offer, which is what the operator observed for this account. Usage that the
offer's observation already covers is not counted again, exactly as in
admission. The provider's
model supplies what does not vary by account: rounding, plan fee, eligibility
and tier. `modelledOfferTerms` reads a model as the rate observation an operator
would post for a new offer.

## What is not built

- **Label-routed work is not accounted.** A job that asks for a provider's label
  never passes through relay admission, so it holds no lease: its cost does not
  reach the budget and its slot does not count against the member. Until the
  relay records those jobs from their `workflow_job` events, a route to a paid
  label provider is bounded only by that provider's own spend limit. This must
  be closed before a workflow reads the table for a paid provider.
- **Workflows do not read `HOBO_CI_FLEET_ROUTES` yet.** Indexing the route
  table per job class is still outstanding. Jobs that run off the box still
  assume its toolchain image and mounts.
- **Host drivers for the sandbox providers** (Agent37, Modal, Boat, Daytona,
  E2B, Lizard, Northflank, Freestyle, Blaxel, Cloudflare Sandbox and Runloop).
  They are modelled and balanced, but the relay
  cannot start a runner on them, so they are not accepted as policy provider
  kinds. Running the Actions runner on any of them is untested. Lizard's
  runners are a label provider and are accepted as the kind `lizard`.
- **A job's own size.** `fleet.machine` compares a job's stated CPU and memory
  need with the machine class, but the relay does not yet state one for a
  routed job, so the check constrains only callers that supply it.
- **Circuit breakers for rented members.** The box daemon marks its own offers
  unhealthy while its host is critically short of CPU, memory, disk or inodes
  (see *Host health* in the runner queue guide). Nothing yet opens a breaker for
  a rented provider after failed launches or slow pickups.
- **Live vendor billing.** The models are published list prices read by hand.
  No provider account, invoice or usage API was exercised.

`jog` and `boat` are accepted as policy provider kinds and dispatch through the
existing companion-workflow bridge, with that bridge's limits: trusted private
repositories only.
