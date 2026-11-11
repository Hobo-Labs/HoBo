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
memory, disk (measured on the filesystem of its runner work directory) and
platform, and sizes jobs by memory only. Anything not reported is
unknown, not zero: a node on an older version that advertises only slots is
ranked by slots alone, and a job with no stated size fits any node with a slot.
A node that cannot take a job says which thing it lacks
(`hobo_ci_mesh_job_unfit`), so "no memory for this job" is not mistaken for "no
slot".

**What nodes know about each other is advice.** A node advertises its id, free
slots, free memory and disk, platform, health, labels and an expiry, and signs
it with its own identity key ([Trust](#trust-whose-advertisement-is-this)). A
missing or expired advertisement removes that node from the ordering and
nothing else; so does one whose signature fails. A node that knows of no one ranks
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
`HOBO_CI_STORE=postgres` is removed under
[ADR-0179](./adr/hosted-relay-stateless.md#adr-0179): the hosted relay keeps
no database for a worker to share.

## The hosted relay stays; the mesh does not depend on it

**Decision:** the hosted relay keeps running. The PWA and the account API
behind `hobo ci` depend on it. What changes is that the path from a queued job
to a running runner no longer goes through it, and that the hosted relay keeps
no durable state of its own
([ADR-0179](./adr/hosted-relay-stateless.md#adr-0179); design in
[Hosted CI Relay Without Durable State](./hosted-relay-stateless.md)). An
earlier version of this section moved its database off Neon to a self-hosted
Postgres; that plan is superseded.

What nodes must agree on lives in JetStream; what one node needs stays on that
node; what the hosted relay serves comes from its config service, from GitHub,
and from a cache whose loss it tolerates.

| State | Where | Why there |
|---|---|---|
| Who has which job | `<namespace>-mesh-claims`, an atomic create per job, aged out | Nodes must agree, without a database |
| Which nodes exist and what they can take | `<namespace>-mesh-nodes`, one signed advertisement per node with total and free slots, aged out | Same |
| The configuration nodes share (offers, connections, policy) | `<namespace>-mesh-config`, key `configuration`, with history; replaced only by naming the current revision | Same; lets a new box start from a NATS address |
| Whose advertisements the mesh trusts | `<namespace>-mesh-config`, key `trust`: the trusted public keys and whether trust is required; same history and revision rule | Nodes must agree on it; it holds public keys only |
| Lease journal, budget ledger and the node's reliability record | Each node's SQLite file (ADR-0135: one partition, one writer) | One writer |
| A node's identity key (Ed25519, private half) | A file beside that node's journal, mode `0600`, made on first start | The private key never leaves the node |
| GitHub App credentials | Files on each node (`HOBO_CI_GITHUB_APP_ID`, `…_PRIVATE_KEY_FILE`) | Private keys are never written to NATS |
| Accounts, policy and the hosted relay's App credentials | The hosted relay's config service, read-only at runtime ([ADR-0179](./adr/hosted-relay-stateless.md#adr-0179)) | What the PWA and the account API read; written by `hobo ci`, not over HTTP |
| The hosted relay's sessions, in-flight leases and webhook intake | Encrypted cookies, a cache it may lose, and a Vercel Queue | Rebuilt from GitHub and Vercel by deterministic names; see [Hosted CI Relay Without Durable State](./hosted-relay-stateless.md) |

**Configuration.** A node with its own file runs that file and is never
overwritten. The first node to connect publishes its configuration if the mesh
has none. A node whose file differs from the mesh's logs
`hobo_ci_mesh_config_drift` and keeps running; an operator decides which side is
right. A node with no configuration of its own reads the mesh's at start, so
adding a box takes a NATS address and App credentials. A changed configuration
takes effect at the next start.

**The hosted relay's database: superseded.** The plan recorded here was to
keep the relay on plain Postgres, move it to a self-hosted server, replace the
Neon runtime-config broker and turn its embedded schema into a Drizzle
definition with migrations. [ADR-0179](./adr/hosted-relay-stateless.md#adr-0179)
replaces that plan: the hosted relay keeps no database at all. Its config and
secrets move to a separate config service it reads with its Vercel OIDC token
(which also removes the broker), its in-flight job state moves to a
Redis-protocol cache with TTL and compare-and-set, its webhook intake and
per-lease steps move to Vercel Queues, and GitHub remains the record of every
job. The PostgreSQL store, the relay database fleet, store selection and the
Drizzle relay schema are removed in phase 7 of
[Hosted CI Relay Without Durable State](./hosted-relay-stateless.md#delivery-plan).
Until then the relay still runs on Postgres as
[`@hobo/ci-vercel`](../../packages/ci-vercel/README.md#database) describes.

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
| `hobo_ci_mesh_node_invalid` | A reader rejects an advertisement: its signature failed, it claims a node id bound to another key, or it asks to be believed further ahead than any node advertises. It is not ranked or counted. Once per node id for as long as it keeps failing |
| `hobo_ci_mesh_trust_changed` | The mesh's trusted-key set changed, with its revision and size |
| `hobo_ci_mesh_capacity_exhausted`, `…_restored` | No healthy node has a free slot: a queued job waits for a slot, not a turn |
| `hobo_ci_mesh_capacity` | Live, healthy and available fleet nodes, total and free slots, free memory and disk across them and the most memory on any one node (the largest job that fits anywhere); on every change and once a minute. Relay hosts and machines running jobs for one repository are not fleet capacity, and with `requireTrusted` neither are untrusted nodes |
| `hobo_ci_mesh_job_unfit` | This node has a free slot but cannot take a job, and what it lacks: memory, disk or platform. Once per job and reason |

Only the live node with the lowest id reports changes about others, so one fact
is reported once; if that node dies, the next takes over on its following
reading and reports the loss.

## Reporting: one list of every node

The events above say what changed. The list says what is: every node, whether
it is there, what it could take and how far its word is trusted. It is one
record (`MeshNodeReport` in `packages/ci-gh-actions/data-models/mesh.proto`,
constrained in CUE) and one function behind every place it is shown, so the
places cannot disagree.

**What a report holds.**

| About | Fields |
|---|---|
| Availability | `state`: `live`, `unhealthy` (advertising, but draining or under pressure) or `lost` (its last advertisement expired); `since` when it entered that state; when the board last received its advertisement; until when that advertisement asked to be believed |
| Capacity | Total and free slots, free memory, free disk, platform (operating system and architecture), labels |
| Trust | `trusted`, `unverified` or `invalid`, and the public key it signed with; see [Trust](#trust-whose-advertisement-is-this) |
| Reliability | The share of recent jobs delivered, and the decayed counts of delivered and dropped jobs behind it |

A field a node does not send stays unknown in its report. It is never shown as
zero. A capacity summary accompanies the list: what the live fleet nodes the
reader does not reject add up to (with `requireTrusted`, only trusted ones).
Relay hosts and machines running jobs for one repository are listed but are
not fleet capacity. One answer lists at most 256 nodes, nodes that are there
before lost ones, and says `truncated` when it left some out; the summary still
covers them all. A reader takes in at most 1024 advertisements in one pass of
the board and logs `hobo_ci_mesh_nodes_capped` (at most once a minute) when it
stops there.

**Who reports.** Every node, whatever else it does:

| Node | What it advertises |
|---|---|
| A box worker | Its slots, memory, disk, platform and labels, and its reliability |
| A developer's or agent's machine running jobs for one repository (`local:runner`) | One slot under `hobo-local-host`, free while its runner waits for a job; memory and disk; its reliability (the share of sessions whose runner ran to its own exit). With no `HOBO_CI_NATS_URL` it advertises nowhere and still writes its own report to `mesh-node.json` in its state directory |
| A relay host | No slots and no labels: it takes no jobs. Its health is its readiness probe. It is on the list so the relay's availability is seen beside the workers' |

A node that stops advertising does not vanish from the list. Its advertisement
expires and the node is `lost` since that moment. A reader that keeps running
(a relay host) goes on listing it as `lost` for an hour after the board has
forgotten it.

**Where to read it.** All three are the same function over the same board:

| Surface | How |
|---|---|
| HTTP | `GET /v1/mesh/nodes` on the relay, with an account credential holding `policy:read`, as for the account API's other reads |
| MCP | The relay's `list_mesh_nodes` tool and `hobo-ci://mesh/nodes` resource, same scope |
| CLI | `hobo ci status` prints a table: node, state, free/total slots, memory, disk, reliability, trust |

A relay with no mesh configured (the hosted relay on Vercel, for one) answers
`mesh: "not-configured"` with an empty list. That is an answer, not an error.
A relay whose board cannot be read answers `mesh: "unreachable"` with its last
reading. `hobo ci status` with no relay to ask (none selected, no credential,
or no network) shows the report the local runner keeps on this machine.

Fleet nodes and relay hosts belong to the relay, not to one account: any
account credential with `policy:read` on that relay sees them, their capacity
and their public keys. A machine running jobs for one repository is somebody's
own computer, and its id is derived from its host name. It advertises the
repository it serves (signed), and is shown in full only to the account whose
configuration connects that repository. Every other account sees it under a
stable opaque id (`local-` and 16 hex digits) with its state, slots, trust and
reliability, and without its platform, key or repository. A local runner that
names no repository is opaque to everyone. None of it holds a secret.

## Trust: whose advertisement is this?

Before signatures, anything written to the board was believed. A node could
not tell another node's advertisement from one written by anybody with access
to the bucket.

**Each node has an identity.** On first start a node makes an Ed25519 key
pair. The private key is written beside the node's SQLite journal with mode
`0600` and never leaves that file: it is not advertised, logged or sent. The
public key travels with every advertisement.

**Each advertisement is signed.** The signature covers a fixed encoding of
what the advertisement says: the node id, the expiry, every figure a reader
ranks by, and the signing key itself, led by a context string so the
signature means nothing anywhere else. Change any of it and the signature no
longer verifies. So an advertisement cannot be moved to another node id, and
cannot be replayed past its expiry: the expiry it was signed with is the one
a reader goes by, and it cannot be extended without the key.

**Each reader decides how far to trust it.** The trust level is never a field
of the advertisement. A node that states its own is not believed.

| Level | When | Ranked for jobs |
|---|---|---|
| `trusted` | The signature verifies, and the key is in an entry bound to this node id; or no entry binds this id and the key is in an unbound entry | Yes |
| `unverified` | No entry binds this id, and the signature verifies with a key the set does not list for any id (or lists only for another id); or there is no signature (a node on an older version) | Yes, as before signatures; no once the mesh sets `requireTrusted` |
| `invalid` | A signature is present and does not verify; or an entry binds this id and the advertisement is signed with another key, or not signed at all; or it asks to be believed more than five minutes and a minute of clock skew ahead | Never. It is reported (`hobo_ci_mesh_node_invalid`) and listed, and counts towards nothing |

**Binding a key to a node id is the normal case.** Once any entry names a
node id, only the keys bound to that id can make it trusted. An unbound entry
does not apply to it, and an advertisement under that id with any other key
is `invalid`: it claims a node whose key the operator has named. An unbound
entry trusts its key under every id nobody has bound, so it is for keys whose
holder the operator trusts with any id. `mesh:trust add` therefore refuses an
unbound entry unless `--any-node` is passed.

**A local runner's key must only ever be bound.** A machine running jobs for
one repository keeps its key at `.hobo/ci-local/mesh-node.key`, inside that
repository's checkout. Every job that runs on that machine can read it. List
it with `--node <its id>` and nothing else: then a job that steals it can sign
only as that one machine, which is no more than it already was. Listed with
`--any-node`, a stolen key could claim any unbound id.

**Keys on disk.** A node refuses to start with its key in a directory group or
others can write (anyone who can write there can swap the key). A key file
others can read is tightened to `0600`; if that fails, the key is refused. A key
already private is never touched, so a key on a read-only filesystem loads.

**Trust settings a node cannot read.** A field a newer version added to the
settings is ignored. Settings that do not parse at all are never half-applied:
the node keeps the last settings it read, and if it has never read any it
fails closed, trusting only its own key and ranking only trusted nodes, until
it reads settings it understands (`hobo_ci_mesh_trust_unreadable` with
`failedClosed`).

The trusted set is the mesh's own configuration: key `trust` in
`<namespace>-mesh-config`, public keys only, replaced only by naming its
current revision. A mesh with no set has each node trust only itself, so
every other node is `unverified` and is ranked as it always was. Nothing
changes for a mesh until its operator lists keys. `mesh:trust` (in
`@hobo/ci-gh-actions`) lists the keys on the board, adds and removes them,
and turns `requireTrusted` on or off; nodes pick a change up within a beat.

**What the signature proves, and what it does not.**

- It proves the advertisement was written by whoever holds that private key,
  for that node id, to be believed until that time, and was not altered.
- It does not say what software the node runs. There is no attestation: a
  node with a listed key that runs modified code is still `trusted`.
- It does not make the node's figures true. Free slots, memory, disk and
  reliability are the node's own word, now attributable to a key.
- It does not prove the key belongs to a machine the operator knows. Listing
  the key is the operator saying so.
- It does not protect the key. Anyone who can read the key file can sign as
  that node, and there is no revocation other than taking the key off the list.

**What trust decides, and what it does not.** A node's trust level decides
whether *other nodes defer to it* when ranking. It does not decide whether
the node may run jobs: that is GitHub App credentials and each node's own
admission, as before. A forged advertisement could only ever cost a job a
step of delay, and an `invalid` one now costs nothing.

**Limits that remain.**

- Whoever can write the config bucket decides whom the mesh trusts. The NATS
  accounts and permissions on that bucket are the root of this trust; the
  mesh does not add one of its own.
- Anyone who can write the nodes bucket can overwrite a node's entry. Under a
  bound id the overwrite is `invalid`; under an unbound id it is `unverified`
  (or, signed with a key listed unbound, `trusted` under that key's holder's
  responsibility). It is never that node, but the node's real advertisement is
  gone until its next beat (10 s). Restricting each node to its own key of the
  bucket closes this; the mesh does not require it.
- An advertisement replayed unchanged is believed until the expiry it was
  signed with, at most 45 seconds as nodes advertise. A reader rejects any
  advertisement asking to be believed more than six minutes ahead (five, plus
  a minute of clock skew), so an old signed advertisement cannot be kept alive
  by giving it a far expiry when it was made.
- Without `requireTrusted`, an unsigned or unlisted node is still ranked.
  That is what keeps a mesh of mixed versions working, and it means trust is
  advisory until the operator turns the requirement on. With it on and no
  keys listed, every node ranks only itself.
- A node that loses its key file gets a new identity and must be listed again.

## Routing reads the mesh when it can

The routing job (`scripts/ci/route-runner.mts`) chooses the fleet, a local box
or GitHub-hosted before a run's jobs are queued. It reads GitHub's queue,
which says what happened to jobs already queued; it could not see a fleet
that was full or gone until jobs had waited on it.

Workers with `HOBO_CI_FLEET_ROUTES=1` in a mesh also keep a snapshot in the
repository variable `HOBO_CI_FLEET_STATE`. It is about 150 bytes and names no
node, key or address.

- **What it lists:** exactly the fleet labels the publishing worker serves,
  each with its live healthy nodes, how many of them it trusts, and their free
  slots, and when it was published. Never `hobo-local-host`: the board is
  shared by every repository, and one developer's busy machine says nothing
  about another repository's local box.
- **Who writes it:** one worker per mesh, elected as the monitor elects its
  reporter: the live, healthy node with the lowest id among those serving a
  fleet label (with `requireTrusted`, among trusted ones). The others stay
  quiet. All workers in a mesh should share the flag: if the elected worker
  does not publish, nobody does, and the snapshot ages out (which changes
  nothing). A node with a lower id that advertises but never publishes can
  hold publishing off the same way; the fallback is the queue, as before.
- **How often:** GitHub limits variable writes, so the worker writes only when
  what routing reads changes (per label, whether there is a node and whether
  there is a free slot), at most every 30 seconds, and otherwise every two
  minutes so a live mesh's snapshot never goes stale, and once more as the
  publisher starts to drain. The log says what routing reads
  (`hobo=open,hobo-trunk=full`), not the value.

| The snapshot | What routing does |
|---|---|
| Fresh (five minutes old or less) and the run's label has no node, or no free slot | That backend is refusing jobs, at once, without waiting for queue evidence |
| Fresh and the label has a free slot | Nothing new. The queue still decides: a snapshot never makes a backend look available |
| Fresh, but the run's label is not listed, or its entry lacks a numeric `nodes` or `freeSlots` | Nothing. The publisher does not speak for that label |
| Missing, unreadable, or more than five minutes old | Nothing. The queue is read exactly as before |

The snapshot sits beside the box's own memory headroom variable,
`HOBO_CI_FLEET_CAPACITY`, which the routing job also reads: each can only
take the fleet out of a decision, and either one saying the fleet cannot
take the job is enough.

The counts are of every live healthy node serving the label that the reader
does not reject, trusted or not, even with `requireTrusted`. That setting
decides whom a worker defers to when ranking; it does not stop an unlisted
worker from picking up a job GitHub hands it, and routing asks whether a job on
this label will start. `invalid` advertisements are never counted. A forged
advertisement can therefore only make a label look as if it has room, which
changes nothing.

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
- **A restart keeps the record.** It is written to the node's SQLite journal
  each time a job is counted, and read back at start, decayed by the time the
  node was down. A worker that crashes and restarts in a loop no longer
  starts each time with a clean record. After a repair, set
  `HOBO_CI_MESH_RELIABILITY_RESET` to a token (`1`, or a date) to clear it: the
  record is cleared once per token, and the token is kept with the record, so a
  variable left set does not clear it again at every restart. A local runner
  takes the same variable. Left alone it recovers on the schedule above.
- **The number is the node's own word**, like its free slots: advice other
  nodes rank by, never a lock. A node cannot observe another's drops. It is
  advertised with the counts behind it, and signed, so it is attributable to
  a key; it is not checked by anyone.

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
| 7 | ~~The hosted relay's database on self-hosted Postgres with a Drizzle schema and migrations; the Neon config broker removed~~ | Superseded by [ADR-0179](./adr/hosted-relay-stateless.md#adr-0179): the hosted relay keeps no durable state; see [its delivery plan](./hosted-relay-stateless.md#delivery-plan) |
| 5 | Per-node budget allowances so priced offers survive a partition | Not started |
| 6 | The advertisement as a protobuf and CUE record (`MeshAdvert`), read as protobuf JSON at the NATS boundary; an older node's advertisement still parses | Done |
| 8 | Reporting: every node (worker, local runner, relay host) advertises availability, capacity and trust; one list on the relay's HTTP route, its MCP tool and resource, and `hobo ci status`; measured free disk; reliability kept in the node's journal | Done; needs a second box to run for real |
| 9 | Trust: a per-node Ed25519 identity, signed advertisements, a trusted-key set in the mesh's configuration, `invalid` nodes never ranked | Done. No attestation of what a node runs, no key rotation or revocation list, and the buckets' access control is NATS's, not the mesh's |
| 10 | Routing reads a mesh snapshot (`HOBO_CI_FLEET_STATE`) as an extra signal when it is fresh | Done; the snapshot is one worker's view, and each worker with the flag writes its own |

A worker with no `HOBO_CI_NATS_URL` behaves exactly as it did. With it and no
peers, it ranks itself first for every job and takes them all, so turning the
mesh on for one box changes nothing but the advertisements it writes. A mesh
with no trusted keys listed ranks exactly as it did before signatures.

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

Reporting and trust:

`packages/ci/test/mesh-trust.test.ts`, `mesh-report.test.ts` and
`packages/ci-gh-actions/test/mesh-records.test.ts`, `mesh-node.test.ts`,
always run:

- A signed advertisement verifies; changing any signed figure, its node id or
  its expiry makes it invalid; so does another key's signature, or a key
  swapped in under a good one.
- A replayed advertisement is stale at the expiry it was signed with, and
  cannot be given a later one.
- An unlisted key and an unsigned (older) node are `unverified` and still
  ranked; an `invalid` node is never ranked, over 500 job ids, and is not
  counted as capacity; with `requireTrusted` only listed keys are ranked, and
  a node always ranks itself.
- An older node's advertisement (none of the new fields) parses, and what
  this version writes is read by the schema the previous version used.
- The identity key file is made once with mode `0600`, is the same after a
  restart, and no part of it appears in an advertisement or a report.
- A worker's reliability record survives closing and reopening its SQLite
  journal, and is decayed for the time in between; the advertisement carries
  measured free disk.

Against a real `nats-server` (`packages/hobo/test/ci-mesh-status.test.ts`, run
when a binary is available): two box workers, a local-runner machine and a
relay host started from its environment, each with its own key file, three
of the four keys listed.

- The relay's HTTP route, its MCP tool and `hobo ci status` each list all
  four with the same states, slots and trust levels (three `trusted`, the
  unlisted worker `unverified`), and `hobo ci status` with no relay answers
  from the local machine's own report.
- An altered advertisement and one replayed with a later expiry are listed
  as `invalid` and add nothing to the capacity.
- One worker is killed: within its advertisement's lifetime all three
  surfaces list it as `lost`, since the moment its advertisement expired.

Routing (`scripts/test/route-runner.test.ts` and
`packages/ci-gh-actions/test/fleet-state.test.ts`): a fresh snapshot with no
node or no free slot for the run's label sends the run elsewhere at once; one
with room, a stale one and a missing one each leave the decision identical to
the queue's alone; a pinned tier does not move.

## Open questions

- **What a node runs.** A signature names a key, not software. Attesting the
  worker image (a signed build, or a TPM quote) is a separate mechanism.
- **Key rotation and revocation.** A key is trusted until it is taken off the
  list. There is no expiry on a listed key and no way for a node to announce
  a new one under its old one.
- **Per-node write access to the board.** NATS can restrict each node to its
  own key of the nodes bucket; the mesh does not set that up.
- **One snapshot per mesh.** Every worker with the flag writes its own view
  to `HOBO_CI_FLEET_STATE`. They agree when they see the same board; a
  partitioned worker would publish a smaller mesh until the others overwrite it.
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

[Hosted CI Relay Without Durable State](./hosted-relay-stateless.md) ·
[Runner queue runbook](../../packages/ci/RUNNER-QUEUE.md) ·
[CI runner balancing example](./ci-runner-balancing-example.md) ·
[Shared budget policy](./shared-budget-policy.md)
