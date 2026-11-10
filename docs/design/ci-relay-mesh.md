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

## Retiring the hosted relay

**Decision:** the hosted relay on Vercel is retired from the CI path. What it
held that several nodes must agree on moves to JetStream; what one node needs
stays on that node.

| State | Was | Now |
|---|---|---|
| Who has which job | Leases in hosted Postgres, when admission was `push` | `<namespace>-mesh-claims`, an atomic create per job, aged out |
| Which nodes exist and what they can take | Not recorded | `<namespace>-mesh-nodes`, one advertisement per node with total and free slots, aged out |
| Account configuration (offers, connections, policy) | Hosted Postgres, edited through the control API | `<namespace>-mesh-config`, one key with history; replaced only by naming the current revision |
| Lease journal and budget ledger | Hosted Postgres | Each node's SQLite file (ADR-0135: one partition, one writer) |
| Queued-job inbox from webhooks | Hosted Postgres | Nothing: each node polls GitHub |
| GitHub App credentials | Encrypted in hosted Postgres, served by a config broker on Neon | Files on each node (`HOBO_CI_GITHUB_APP_ID`, `…_PRIVATE_KEY_FILE`); never written to NATS |
| OAuth sessions and App onboarding pages | Hosted Postgres | Retired with the relay; the App is already registered |

**Configuration.** A node with its own file runs that file and is never
overwritten. The first node to connect publishes its configuration if the mesh
has none. A node whose file differs from the mesh's logs
`hobo_ci_mesh_config_drift` and keeps running; an operator decides which side is
right. A node with no configuration of its own reads the mesh's at start, so
adding a box takes a NATS address and App credentials. A changed configuration
takes effect at the next start.

**Not moved, on purpose.** Private keys stay out of NATS. A shared budget across
nodes is not solved by this: each node meters its own spend, so priced offers
belong on one node until per-node allowances exist (increment 5).

**What is lost with the relay.** Webhook-driven pickup (nodes poll every 5 s
instead), the hosted account API behind `hobo ci`, and the Vercel Sandbox host.
The `@hobo/ci-vercel` package stays in the repository until those are either
re-homed or deleted. Taking the deployment itself out of service is an
operator step: pause the Vercel project and remove the GitHub App's webhook
URL, which otherwise keeps delivering to it.

## Watching capacity and availability

Ranking reads the board at the moment a job is queued. Operating a mesh needs
the changes, so every node also runs a monitor on its 10-second beat:

| Event | Means |
|---|---|
| `hobo_ci_mesh_node_joined` | A node started advertising |
| `hobo_ci_mesh_node_lost` | A node's advertisement aged out: it stopped, crashed or was cut off |
| `hobo_ci_mesh_node_unhealthy`, `…_recovered` | A node is draining or under pressure, or is back |
| `hobo_ci_mesh_capacity_exhausted`, `…_restored` | No healthy node has a free slot: a queued job waits for a slot, not a turn |
| `hobo_ci_mesh_capacity` | Live, healthy and available nodes, total and free slots; on every change and once a minute |

Only the live node with the lowest id reports changes about others, so one fact
is reported once; if that node dies, the next takes over on its following
reading and reports the loss.

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
| 4 | The hosted relay retired from the CI path; shared configuration in JetStream; a monitor for node capacity and availability | Done; wake-up hints on a NATS subject not started |
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
