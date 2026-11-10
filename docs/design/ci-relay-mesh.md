---
type: Design
title: "CI Relay Mesh"
description: "Proposal: run the CI relay as a mesh of equal nodes that each read GitHub's queue and agree on who starts a job by arithmetic, so no relay is a single point of failure."
tags: [hobo, design, ci]
---

# CI Relay Mesh

**Status:** implemented behind a setting. The box worker joins a mesh when
`HOBO_CI_NATS_URL` is set and is unchanged without it. Proven against a real
NATS server with several nodes in one process; not yet run with two real boxes.
[Increments](#increments) lists what is done and what is left.

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

**Capacity for this job decides the order.** A free slot is not enough: the
job has to fit. Each node advertises what it has free besides slots (today, the
memory it could give a new job), and each job is sized by the memory class the
worker would reserve for it at launch. A node is a candidate for a job only when
that job fits it, and it is weighted by how many copies of that job it could
start, the smaller of its free slots and what its free memory holds.

| Node | Free slots | Free memory | A 6 GB test shard | A 1 GB scan |
|---|---|---|---|---|
| wide | 8 | 2 GB | not a candidate: no memory for it | candidate, weight 2 |
| deep | 1 | 8 GB | candidate, weight 1 | candidate, weight 1 |

So the heavy job goes to `deep` at once instead of waiting a turn on `wide`,
which would have claimed it and then been unable to start it. The ordering is
weighted rendezvous hashing over those weights: a node that could start twice
as many of this job is first for twice as many of them. A node that is full,
draining or under host pressure drops out of the ordering; its jobs go to the
next node. When a node leaves, only the jobs it was first for move.

The same check covers disk and platform (operating system and architecture)
when a node reports them and a job asks for them. Today the worker reports
memory and platform, and sizes jobs by memory only. Anything not reported is
unknown, not zero: a node on an older version that advertises only slots is
ranked by slots alone, and a job with no stated size fits any node with a slot.
A node that cannot take a job says which thing it lacks
(`hobo_ci_mesh_job_unfit`), so "no memory for this job" is not mistaken for "no
slot".

**What nodes know about each other is advice.** A node advertises its id, free
slots, free memory, platform, health, labels and an expiry. A missing or expired advertisement removes
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

## No hosted database in the job path

**Decision:** taking a job from GitHub's queue to a running runner must not
depend on the hosted relay or on any hosted database. On 2026-11-10 the hosted
relay's Postgres on Neon went over its plan quota and the relay answered 503
to everything, GitHub's webhook deliveries included.

A worker already has what it needs to stand alone, and the mesh keeps it that
way:

| Piece | In this topology | Needs |
|---|---|---|
| Lease journal | SQLite file on the box (`HOBO_CI_STORE` unset; the default) | Local disk |
| Finding jobs | The worker polls GitHub (`pull` admission; the default with SQLite) | GitHub |
| Starting runners | The worker mints just-in-time runners with its own App credentials | GitHub |
| Sharing a queue between workers | Relay mesh | NATS, or nothing: ranking alone still works |
| Hosted relay on Vercel | Not involved | — |

The settings that would tie a worker to the hosted database are
`HOBO_CI_STORE=postgres` and `HOBO_CI_JOB_ADMISSION=push`. Neither is a
default, and a mesh needs neither; the mesh gate applies only to `pull`.

## The hosted relay stays; the mesh does not depend on it

**Decision:** the hosted relay keeps running. The PWA and the account API
behind `hobo ci` depend on it. What changes is that the path from a queued job
to a running runner no longer goes through it, and that its database moves off
Neon to a self-hosted Postgres.

What nodes must agree on lives in JetStream; what one node needs stays on that
node; what the hosted relay serves stays in its Postgres.

| State | Where | Why there |
|---|---|---|
| Who has which job | `<namespace>-mesh-claims`, an atomic create per job, aged out | Nodes must agree, without a database |
| Which nodes exist and what they can take | `<namespace>-mesh-nodes`, one advertisement per node with total and free slots, aged out | Same |
| The configuration nodes share (offers, connections, policy) | `<namespace>-mesh-config`, one key with history; replaced only by naming the current revision | Same; lets a new box start from a NATS address |
| Lease journal and budget ledger | Each node's SQLite file (ADR-0135: one partition, one writer) | One writer |
| GitHub App credentials | Files on each node (`HOBO_CI_GITHUB_APP_ID`, `…_PRIVATE_KEY_FILE`) | Private keys are never written to NATS |
| Accounts, App registration, sessions, the webhook inbox | The hosted relay's Postgres | What the PWA and the account API read |

**Configuration.** A node with its own file runs that file and is never
overwritten. The first node to connect publishes its configuration if the mesh
has none. A node whose file differs from the mesh's logs
`hobo_ci_mesh_config_drift` and keeps running; an operator decides which side is
right. A node with no configuration of its own reads the mesh's at start, so
adding a box takes a NATS address and App credentials. A changed configuration
takes effect at the next start.

**The hosted relay's database.** The relay speaks plain Postgres through
`DATABASE_URL` and creates its own tables; nothing in its store is specific to
Neon. Against a self-hosted PostgreSQL 16.15 the store's 68 real-database tests
pass, and the relay starts, creates its 18 tables and reports that it is
waiting for the GitHub App. `packages/ci-vercel/deploy/postgres/compose.yaml`
runs one. Two things still tie a production relay to Neon, and are the work
that remains:

- Its production start-up reads credentials from a runtime-config broker whose
  Neon address is fixed in `packages/ci-vercel/src/entry.ts`. Setting the App
  credentials or the bootstrap token directly in the relay's environment
  bypasses the broker today; removing the broker is a code change.
- Its schema is 26 `CREATE TABLE IF NOT EXISTS` statements inside the store. The
  plan is to make that schema a Drizzle definition with generated migrations
  (`packages/adapters/adapter-drizzle` is the repository's Drizzle home), so a
  self-hosted database is created and upgraded the same way everywhere.

Neither is done in this change.

**A shared budget across nodes** is not solved either: each node meters its own
spend, so priced offers belong on one node until per-node allowances exist
(increment 5).

## Watching capacity and availability

Ranking reads the board at the moment a job is queued. Operating a mesh needs
the changes, so every node also runs a monitor on its 10-second beat:

| Event | Means |
|---|---|
| `hobo_ci_mesh_node_joined` | A node started advertising |
| `hobo_ci_mesh_node_lost` | A node's advertisement aged out: it stopped, crashed or was cut off |
| `hobo_ci_mesh_node_unhealthy`, `…_recovered` | A node is draining or under pressure, or is back |
| `hobo_ci_mesh_capacity_exhausted`, `…_restored` | No healthy node has a free slot: a queued job waits for a slot, not a turn |
| `hobo_ci_mesh_capacity` | Live, healthy and available nodes, total and free slots, free memory across the mesh and the most on any one node (the largest job that fits anywhere); on every change and once a minute |
| `hobo_ci_mesh_job_unfit` | This node has a free slot but cannot take a job, and what it lacks: memory, disk or platform. Once per job and reason |

Only the live node with the lowest id reports changes about others, so one fact
is reported once; if that node dies, the next takes over on its following
reading and reports the loss.

## Reliability: a node that drops jobs gets fewer

Capacity says what a node could take. It does not say whether the node will
see the job through. A box with a full disk still has free slots; it claims a
job, fails to start a runner, and the job waits until another node's turn.
Every job it is ranked first for pays that delay.

So each node keeps a record of the jobs it took and advertises one number,
the share of its recent jobs it **delivered**:

| Counted as | When |
|---|---|
| Delivered | One of the node's runners picked the job up (`hobo_ci_job_pickup`), whatever the job's own result. A failing test is the job's business |
| Dropped, `never-started` | The job is still queued ten minutes after the node claimed it |
| Dropped, `launch-failed` | Starting the runner failed repeatedly and the launch was given up (`hobo_ci_launch_parked`) |
| Dropped, `out-of-memory` | The job's container was killed for memory (`hobo_ci_container_oom`) |
| Dropped, `runner-lost` | The runner disappeared mid-job (`hobo_ci_orphan_job_confirmed`). The delivery it was credited with is taken back |

A job that leaves the queue some other way (cancelled, or started by another
node) is neither: the node stops seeing it queued and forgets its claim.

**How it changes ranking.** A node's weight in the rendezvous order is the
copies of the job it could start *times* this number. Two equal nodes, one of
which drops half of what it takes, are first for two thirds and one third of
jobs. Capacity still counts: eight free copies at one half outweigh two at
full trust. A node that says nothing (an older version) is fully trusted.

**How it recovers.** The record decays: every half-life (30 minutes by
default, `HOBO_CI_MESH_RELIABILITY_HALF_LIFE_MS`) a past job counts for half
as much. Nothing is reset by hand and nothing is held against a node forever.

| After ten jobs dropped in a row (a disk fills) | Share of capacity it is ranked with |
|---|---|
| At once | 0.29 |
| 30 minutes after the drops stop, nothing delivered since | 0.44 |
| The same 30 minutes, with ten jobs delivered since the fix | 0.74 |
| 1 hour, nothing delivered | 0.62 |
| 2 hours, nothing delivered | 0.86 |
| 3 hours, nothing delivered | 0.96 |
| 6 hours, nothing delivered | above 0.99 |

- **Four imaginary deliveries** stand behind every node, so one early drop on
  a new node costs a fifth of its share, not all of it.
- **A floor of 0.05.** However poor the record, the node is still ranked with a
  twentieth of its capacity. A node that got no work could never deliver a
  job, and its score could only come back by waiting; a small share keeps real
  evidence arriving. If it is still broken, those few jobs fall to the next
  node one step later, as any failed first choice does.
- **Old deliveries fade too**, so a long good record does not hide a node that
  has just started failing.
- **A restart clears the record.** It is kept in the worker's memory. That is
  the fast path after a repair: fix the box, restart the worker, and it is
  trusted again at once. It is also a gap: a worker that crashes and restarts
  in a loop starts each time with a clean record. A node that is down does not
  advertise and is not ranked; one that is up between crashes is.
- **The number is the node's own word**, like its free slots: advice other
  nodes rank by, never a lock. A node cannot observe another's drops.

`hobo_ci_mesh_job_dropped` reports each drop with its reason and the score it
left, and `hobo_ci_mesh_reliability` reports the score each time it has moved
a twentieth, down or back up.

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

### NATS as the transport

HoBo's default host already meshes over NATS and JetStream
([ADR-0031](./adr/01-architecture-core.md#adr-0031)), so a mesh of CI
nodes can use the same substrate instead of a second one. It maps onto this
design directly:

| Need | NATS feature |
|---|---|
| Advertisements with an expiry | A JetStream key-value bucket with a per-key TTL |
| "One node starts this job" | A work-queue stream: one consumer receives each message, and an unacknowledged one is redelivered to another node |
| Wake-up hints instead of webhooks to one relay | A subject each node subscribes to |
| Nodes behind NAT | Leaf nodes, which only connect outward |

NATS makes the claim exact where the arithmetic is approximate: while the
cluster has quorum, one node starts each job and no runner is started twice.
What it does not remove is the question of what happens without it. JetStream
needs a majority of its servers, so a NATS cluster is a replicated centre, not
the absence of one, and a single box gains a dependency rather than losing one.

The two compose. NATS is the fast path and the bulletin board. `claimTurn` is
what a node does when it cannot reach NATS, or when the cluster has lost quorum:
it ranks on its last view and waits its turn. With that fallback a NATS outage
costs duplicate start-up work, not a stopped queue. Increment 2's bulletin-board
port should therefore have two adapters, GitHub variables and NATS, behind one
interface.

## Increments

| # | Adds | State |
|---|---|---|
| 1 | The claiming core: `rankNodes` and `claimTurn` in `@hobo/ci/mesh`, pure functions with property tests | Done |
| 2 | Board and claim ports, a coordinator that falls back to ranking when they fail, an in-memory adapter, and a NATS key-value adapter (`@hobo/ci-gh-actions/mesh-nats`) | Done |
| 3 | The worker asks the mesh before it takes a queued job, advertises its free slots, and says so when it drains; settings in the runbook | Done; needs a second box to run for real |
| 4 | Shared configuration in JetStream and a monitor for node capacity and availability; the hosted relay out of the job path | Done; wake-up hints on a NATS subject not started |
| 7 | The hosted relay's database on self-hosted Postgres with a Drizzle schema and migrations; the Neon config broker removed | Not started |
| 5 | Per-node budget allowances so priced offers survive a partition | Not started |
| 6 | The advertisement as a protobuf and CUE record; it is JSON checked at the NATS boundary today | Not started |

A worker with no `HOBO_CI_NATS_URL` behaves exactly as it did. With it and no
peers, it ranks itself first for every job and takes them all, so turning the
mesh on for one box changes nothing but the advertisements it writes.

## What the tests establish

Against a real `nats-server` (`packages/ci-gh-actions/test/mesh-nats.e2e.test.ts`,
run when a binary is available):

- Four connections racing for 200 jobs: each job is claimed by exactly one.
- A node that stops advertising is forgotten; a claim ages out and frees the job.
- Three nodes with 1, 2 and 5 slots take 400 jobs once each, in that proportion.
- The largest node dies silently: the others take its jobs one step later, once each.
- The server is killed: every job is still started, and the outage is logged.
- The server returns on the same address: the clients reconnect on their own and
  claims are exact again.

On the in-memory mesh (`packages/ci/test/mesh-coordinator.test.ts`), always run:
the same once-each, capacity and failover properties, plus ranking alone when
the claim store rejects, and the last view being kept when the board fails.

The ranking itself:

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

Reliability (`packages/ci/test/mesh-reliability.test.ts` and
`packages/ci-gh-actions/test/mesh-worker.test.ts`):

- The score is the decayed share of jobs delivered, never zero, and 1 for a
  node with no drops; ten drops in a row take it to 0.29.
- It rises on its own once drops stop, at every step of a ten-hour check, and
  faster when jobs are delivered after the fix.
- Over 8,000 job ids, a node that delivers half its jobs is first for a third
  of them against an equal peer; a node with a ruined record keeps about one
  job in twenty-one; a node that says nothing splits evenly with one at 1.
- A worker counts a drop for a launch given up, a container killed for memory,
  a runner lost after pickup (taking the delivery back) and a job still queued
  ten minutes after it claimed it, each once; it counts nothing for a job it
  never took or one that was cancelled.
- Through two workers on one board, the one that dropped ten jobs is first for
  about a fifth of new jobs instead of half.

## Open questions

- **Reliability across restarts.** The record is in memory. Keeping it in the
  worker's journal would close the crash-loop gap, at the cost of a repair no
  longer clearing it by restart.
- **Rented providers.** The fleet balancer has a circuit breaker per member
  (healthy or not). The same decayed score could rank rented providers by how
  often their runners arrive; it does not yet.

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
