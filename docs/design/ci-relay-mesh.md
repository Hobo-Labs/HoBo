---
type: Design
title: "CI Relay Mesh"
description: "Proposal: run the CI relay as a mesh of equal nodes that each read GitHub's queue and agree on who starts a job by arithmetic, so no relay is a single point of failure."
tags: [hobo, design, ci]
---

# CI Relay Mesh

**Status:** proposed. The claiming core is implemented and tested
(`@hobo/ci/mesh`); nothing calls it yet. The sections under
[Increments](#increments) say what each later step adds.

## Why

Today one hosted relay receives every webhook and one box runs every job. Either
one failing stops CI. On 2026-11-10 the hosted relay answered 503 on every path,
its health checks included, and logged nothing. Jobs still ran, which fits the
box polling GitHub itself, but they waited up to 26 minutes for a runner on the
one host.

The goal is a relay with no centre: any node with capacity can take any job it
is allowed to run, and losing a node, or the path between two nodes, slows a job
by seconds instead of stopping it.

## The idea

**Every node is a whole relay.** A node reads the queue from GitHub, applies the
account's policy, starts its own runner and reports its own results. This is
what the box worker already does: it polls GitHub for queued jobs and mints a
just-in-time runner for each. A node needs GitHub and nothing else.

**GitHub's queue is the only shared truth.** A job is queued, assigned to one
runner, and finished, and GitHub decides each of those. Nodes never hand each
other jobs and never hold a lock for each other.

**Nodes agree by arithmetic.** For one job, every node computes the same
ordering of the nodes it knows about. The first node starts a runner at once.
The node at rank `r` waits `r` steps, counted from the moment GitHub queued the
job, and starts only if the job is still queued. No node waits for another
node's answer, so a dead node costs the job one step.

| Time since the job was queued | Who starts a runner |
|---|---|
| 0 | the node ranked first |
| 1 step (20 s proposed) | the node ranked second, if the job is still queued |
| 2 steps | the node ranked third, if still queued |
| `maxRank` steps (4 proposed) | every remaining node, if still queued |

**Capacity decides the order.** The ordering is weighted rendezvous hashing over
each node's free runner slots. A node with twice the free capacity is first for
twice as many jobs. A node that is full, draining or under host pressure
advertises no free slots and drops out of the ordering; its jobs go to the next
node. When a node leaves, only the jobs it was first for move.

**What nodes know about each other is advice.** A node advertises its id, free
slots, health, labels and an expiry. A missing or expired advertisement removes
that node from the ordering and nothing else. A node that knows of no one ranks
itself first and starts immediately, which is exactly what a single box does
today. The mesh degrades to independent nodes, never to a stopped queue.

## What can go wrong, and what it costs

| Failure | Result |
|---|---|
| A node dies | Its jobs start one step later on the next node. |
| A node is full or unhealthy | It advertises no slots; others rank without it, with no delay. |
| Two nodes see different members | Both may start a runner. GitHub assigns the job to one; the other runner finds nothing and exits. Cost: an idle container for its start-up time. |
| The bulletin board is unreachable | Nodes rank on their last good view until it expires, then alone. |
| Clocks disagree | Turns shift by the skew. A queue time in the future is treated as now. |
| A node cannot reach GitHub | It starts nothing. The others never waited for it. |
| The hosted relay is down | Nothing. It becomes a wake-up hint (see increment 4), not a dependency. |

The design chooses availability over a single agreed view. The worst outcome of
disagreement is duplicated start-up work, bounded by GitHub's single
assignment. It is never a lost job or a job run twice.

## What stays consistent

Three things must not be decided per node on a guess.

- **Who may run what.** Public repositories and pull requests need an isolated
  host. That rule is part of each node's own admission and does not depend on
  the mesh. A node that is not allowed to run a job is never in its ordering.
- **Money.** Free and self-hosted capacity fails open: a node may always use its
  own box. A priced offer needs the shared budget; a node that cannot reach the
  budget authority must not spend, and drops that offer from what it advertises.
- **Configuration.** Nodes read the same account policy. A node on an old
  revision still makes safe decisions, because admission fails closed.

## Membership without a centre

Nodes need a place to leave advertisements that every node can already reach.
Two candidates, usable together:

1. **GitHub repository variables**, one per node. Every node can reach GitHub by
   definition, and the proposed fleet route table writes one variable the same
   way. A variable is small and needs only the App's `Variables: write`. Reads
   use ETags, so an unchanged board costs no rate limit.
2. **Direct exchange between nodes** that can reach each other, as an
   optimisation where it works. A node behind NAT simply does not offer it.

Neither is required for correctness. With no board at all, each node runs alone.

## Increments

| # | Adds | State |
|---|---|---|
| 1 | The claiming core: `rankNodes` and `claimTurn` in `@hobo/ci/mesh`, pure functions with property tests | Done |
| 2 | The advertisement record (protobuf and CUE) and a bulletin-board port with a GitHub-variable adapter | Not started |
| 3 | The worker asks `claimTurn` before it mints a runner; `stepMs` and `maxRank` become settings; a second box joins | Not started |
| 4 | The hosted relay only forwards wake-up hints; a node treats a missing hint as a slower poll | Not started |
| 5 | Per-node budget allowances so priced offers survive a partition | Not started |

Increment 3 is the first one that changes behaviour, and it needs a second node
to prove anything. Until then a single box behaves exactly as it does now.

## What the tests establish

`packages/ci/test/mesh-rendezvous.test.ts`, over 6,000 job ids:

- Every node computes the same order, whatever order it learned of the others in.
- First places follow capacity: slots of 1, 2 and 5 take 1/8, 2/8 and 5/8 of
  jobs within two points.
- Removing one of four nodes moves only the quarter of jobs it was first for;
  the survivors keep their relative order for every job.
- With complete views exactly one node starts at once, and the others' turns are
  one and two steps away.
- With each node knowing only one neighbour, at least one node starts at once,
  and after any single node is lost at least one survivor has started within one
  step.
- In a mesh of 40 with `maxRank` 3, no node waits more than three steps.

## Open questions

- **Step length.** Twenty seconds trades duplicate starts against failover time.
  The worker's measured pickup time (`hobo_ci_job_pickup`) should set it.
- **Fairness across repositories.** Ranking is per job. Whether a busy
  repository should be spread or kept on warm nodes is a policy choice.
- **Cache locality.** A node with a warm dependency layer for a repository is a
  better first choice. That is a weight, and can be added without changing the
  mechanism.

## Related

[Runner queue runbook](../../packages/ci/RUNNER-QUEUE.md) ·
[CI runner balancing example](./ci-runner-balancing-example.md) ·
[Shared budget policy](./shared-budget-policy.md)
