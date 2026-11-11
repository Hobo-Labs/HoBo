---
type: Design
title: "Hosted CI Relay Without Durable State"
description: "Redesign of the hosted CI relay on Vercel as a twelve-factor process: config and secrets in a separate service, short-lived job state in a Redis-protocol cache with TTL and compare-and-set, Vercel Queues for intake and per-lease steps, and GitHub as the system of record for jobs. No database."
status: Accepted
tags: [hobo, design, ci, relay, twelve-factor]
---

# Hosted CI Relay Without Durable State

**Status:** design accepted as
[ADR-0179](./adr/hosted-relay-stateless.md#adr-0179), amended on 2026-11-11
with [Options routed by budget](#options-routed-by-budget). Implemented so far
([delivery plan](#delivery-plan)): the cache port and its Upstash, Valkey,
in-memory and Turso bindings (phases 2 and 2b), the config-service
client (phase 3), the relay store on the cache (phase 4a) and, in phase 4b, the
relay composed on them with no database: config and secrets from the config
service, per-job state in the cache, webhook intake and per-lease steps on
Vercel Queues ([The stateless relay](../../packages/ci-vercel/README.md#the-stateless-relay)).
None of it has been deployed or run against Vercel, Upstash, Infisical or
GitHub. The PostgreSQL code stays in the tree, off the relay's path, until
phase 7 removes it; the sections of
[`@hobo/ci-vercel`](../../packages/ci-vercel/README.md) that describe it are
marked superseded.

## Why

On 2026-11-10 the hosted relay's Postgres on Neon went over its plan quota and
the relay answered 503 to everything, GitHub's webhook deliveries included
([CI Relay Mesh](./ci-relay-mesh.md#no-hosted-database-in-the-job-path)). The
response so far has been to make the database more available: a store chosen
among several attached ones, a relay database fleet across providers with a
writer register and replication, a Drizzle schema with migrations, and a plan
to self-host Postgres. Each step added machinery the relay must operate, and
none changed the fact that a relay with a database is down when its database
is.

Most of what the relay writes does not need to outlive a job. GitHub already
holds the authoritative state of every job, the relay already re-reads it
before acting
([`hosted-relay.ts`](../../packages/ci-gh-actions/src/hosted-relay.ts), the
REST re-reads around lines 802–833 and 897–925), and the remaining state is
configuration, secrets and counters with a natural expiry. So the relay should
keep no durable state of its own: a twelve-factor process with its config in
the environment's config service, its backing services attached by binding,
and its short-lived state in a cache whose loss it tolerates.

## Words used here

| Term | Means |
|---|---|
| **Hosted relay** | The relay deployed on Vercel from `@hobo/ci-vercel`: one function, a queue consumer and a schedule |
| **Relay database fleet** | The machinery that runs the hosted relay on several PostgreSQL databases: store selection, the writer register, replication, failover (`packages/ci-vercel/src/database-*.ts` over `@hobo/data-postgres`'s fleet module). Removed by this design |
| **Compute fleet** | The machines that run jobs: the mesh, capacity, runner routing and balancing, NATS mesh state (`packages/ci/src/fleet/`, `packages/ci-gh-actions/src/fleet-*.ts`, `mesh-nats.ts`). Unchanged |
| **Cache** | A store reached through the ephemeral-state port (`EphemeralStatePort`): Redis- or Valkey-protocol, or libSQL. Holds state that may be lost |
| **Cache fleet** | The cache backends the relay may use, of which exactly one is active, chosen by budget policy ([options](#options-routed-by-budget)). The relay's *state* fleet; not the compute fleet |
| **Lifecycle driver** | What advances a job's lifecycle steps: Vercel Queues or Vercel Workflows, chosen per job at admission |
| **Config service** | The service that holds the relay's configuration and secrets. First binding: Infisical Cloud |

"Fleet" alone is ambiguous in this repository and is not used below.

## State classes

| Class | What | Where | Lifetime | Loss means |
|---|---|---|---|---|
| Secrets | GitHub App private key, webhook secret, OAuth client secret, session key, cron secret, onboarding token | Config service, read-only to the relay, cached in process memory | Until rotated | The relay holds no copy that matters; if the config service is unreachable a cold instance cannot start, and warm instances keep their in-memory copy |
| Config | Accounts, policy, offers with declared budget caps, connections, control-token digests, routing preferences | Config service, read-only to the relay, cached in process memory with a short refresh | Until an operator changes it | Same as secrets |
| In-flight job state | One lease record per job attempt, job-taken markers, a small per-account in-flight index, intent timestamps | Cache, with TTL | Until the job is terminal, plus a margin | Rebuilt from GitHub and Vercel by deterministic names |
| Sessions | Signed-in operator sessions, OAuth `state` | Encrypted signed cookies; `state` single-use in the cache | Minutes to hours | The operator signs in again |
| Short-lived counters | Scanner locks and cursors, API-rate windows, redelivery cooldowns, egress mirror, the MCP change ring, worker health, usage pulled from providers | Cache, with TTL | Seconds to days | Recomputed on the next tick; a lost cursor restarts its scan |
| Removed | The event journal, terminal tombstones, snapshot backups, the partition lock, store selection, the relay database fleet's registers, the migration ledger | Nowhere | — | — |

The relay writes nothing that must survive the loss of its cache. The only
durable state it depends on is the config service, which it only reads, and
GitHub.

## Architecture

```mermaid
flowchart LR
  GH["GitHub<br/>(system of record for jobs)"] -->|webhook| R["Relay function"]
  R -->|enqueue, idempotencyKey = delivery id| QI[("Vercel Queue<br/>intake")]
  QI --> C["Queue consumer"]
  C -->|delayed step messages| QS[("Vercel Queue<br/>lease steps")]
  QS --> C
  C <-->|TTL, CAS, INCR| K[("Cache<br/>kv.redis-compatible/v1")]
  C -->|REST re-read, JIT, dispatch| GH
  C -->|create / stop by name| SB["Vercel Sandbox"]
  CFG[("Config service<br/>Infisical")] -->|read-only, Vercel OIDC| R
  CFG -->|read-only, Vercel OIDC| C
  S["Schedule (15 min)"] --> QS
```

## Config and secrets are a separate service

The relay reads its configuration and secrets from a config service and never
writes to it.

- **First binding: Infisical Cloud on the free plan.** It is open source, so
  the same service can later run on HoBo's own compute without a client change.
  The relay's secret references use the existing `infisical` scheme of
  `SecretRef` ([`secret-ref.ts`](../../packages/bindings/src/secret-ref.ts)).
- **No secret zero on the relay.** The relay authenticates with the Vercel
  OIDC token every function already has (`@vercel/oidc`, a dependency today)
  through Infisical's OIDC Auth. The relay's machine identity trusts the issuer
  `https://oidc.vercel.com/<team>` and binds the token's subject to this
  project and its production environment. It has read access to one project
  environment and nothing else.
- **CI has its own identity.** The deploy workflow authenticates with GitHub
  Actions OIDC to a separate admin identity bound to this repository's
  protected deployment environment. That identity can read the Vercel deploy
  credential and write configuration; the relay's identity can do neither.
- **What lives there.** Config: accounts, policy, offers (with their declared
  budget caps and whether they are free, prepaid or pay-as-you-go), repository
  connections, control-token digests, routing preferences. Secrets: the GitHub
  App private key, webhook secret and OAuth client secret, the session key, the
  cron secret, the onboarding token. Config is one revisioned document; each
  secret is its own entry.
- **Caching.** A function instance reads config and secrets once at start and
  refreshes config at most once a minute. A refresh that fails keeps the last
  good copy and logs it; a cold instance that cannot read the config service
  fails its readiness probe and answers 503 with `Retry-After`, as a relay with
  a down store does today.
- **Fallback binding.** GCP Secret Manager through Vercel OIDC workload
  identity federation implements the same port. Its free tier is small (a
  handful of active secret versions and a monthly access allowance, per
  Google's pricing page; re-check before choosing it), so on that binding the
  config document and the secrets are stored as two bundled entries.

The relay's broker on Neon (`neon-secret-broker.ts`, `neon-broker-entry.ts`,
`runtime-config-client.ts`, and the broker address fixed in `entry.ts`) is
replaced, not ported.

## No database: a cache with TTL and compare-and-set

Short-lived per-job state lives in a cache that speaks the Redis or Valkey
protocol. The relay's port is the existing `@hobo/kv-redis-compatible`
requirement with `ttl`, `atomicIncrement` and `atomicCompareAndSet`, so any
store that passes that package's conformance suite can serve it.

- **First binding on Vercel: Upstash Redis through the Vercel Marketplace, free
  tier.** As stated by the vendor at the time of writing: 256 MB and 500,000
  commands a month free, then pay-as-you-go at $0.20 per 100,000 commands.
  Re-check at provisioning. It is chosen because it costs nothing and needs no
  infrastructure. This is a new Marketplace binding; it is not the
  `upstash.temporary-redis/v1` provider in
  [`@hobo/provider-upstash`](../../packages/providers/provider-upstash/README.md).
- **Self-hosted Valkey binds to the same port** with no relay code change.
- **Turso (libSQL) binds to the same port** through
  [`@hobo/provider-turso`](../../packages/providers/provider-turso/README.md),
  with the same semantics and the same conformance suite. Which of these
  serves at a given time is chosen by budget policy, not fixed here: see
  [Options routed by budget](#options-routed-by-budget).
- **Loss is tolerated.** Every key has a TTL, and everything in the cache can
  be rebuilt from GitHub and Vercel by deterministic names
  ([below](#github-is-the-system-of-record-for-jobs)). An empty cache costs a
  rebuild pass, not a lost job.
- **Command budget is a design constraint.** Work is driven by events (queue
  messages, including delayed ones), never by polling the cache. The
  [cost model](#cost-model) counts commands per job and per repair tick.
- **Namespacing.** Keys are prefixed `hobo-ci:<environment>:`. Production and
  preview deployments use separate cache databases where the Marketplace
  integration allows it, and separate prefixes always.

## Vercel Queues: where they fit and where they do not

| Use | How | Replaces |
|---|---|---|
| Webhook intake | The relay verifies the signature, enqueues the delivery with `idempotencyKey` = the `X-GitHub-Delivery` id (deduplicated for 24 h, retained at most 7 days, delivered at least once, retried with back-off honouring `Retry-After`) and only then acknowledges GitHub | `hobo_ci_inbox` |
| Per-lease lifecycle steps | Dispatch check, claim timeout, reconcile and each Sandbox step are delayed messages with idempotency key `${leaseId}:${step}:${n}`. A step reads the lease, acts, and enqueues the next step | Scans over every in-flight lease on each tick |
| Repair ticks | The `hobo-ci-repair` schedule publishes to the queue, as today | — |
| Retries | A step that fails transiently is redelivered by the queue with back-off | Hand-written retry loops |

Queues are **not** used for anything that must be read, compared or browsed:
state reads, compare-and-set and mutual exclusion, counters and quotas, the
MCP change feed, config or secrets. A queue cannot be read back or listed, so
each of those stays in the cache or the config service.

A delivery the consumer can never admit (it does not parse, or names an
unknown installation) is acknowledged, logged as
`hobo_ci_webhook_quarantined` with its delivery id, and dropped. An operator
redelivers it from GitHub with `hobo ci` within GitHub's three-day window. The
quarantine list and its retry endpoint go away with the inbox.

## GitHub is the system of record for jobs

The relay already treats GitHub's REST view of a job and its run as
authoritative before it writes anything. This design leans on that fully.

**Deterministic lease ids.** A lease id is a UUIDv5, under a fixed HoBo
namespace, of `repositoryId:jobId:runAttempt`. When a verified queued job is
re-admitted after its host was settled, the requeue generation `g` is appended
(`repositoryId:jobId:runAttempt:g`, for `g > 0`), so generation 0 is exactly
the plain key. Every external name follows from the lease id:

| Thing | Name | Where it is made today |
|---|---|---|
| JIT runner | `hobo-<leaseId>` | `job-runner-custody.ts` |
| Workflow-bridge run | display title `HoBo lease <leaseId>` | `hosted-relay.ts`, `discover()` |
| Vercel Sandbox | `hobo-<leaseId>` | `sandbox-controller.ts` |

**Rebuilding a lost lease.** For each queued or in-progress job the relay can
see (the queued-job scanner already lists them), it computes the lease ids for
generations 0 to the bound, and looks up runners, bridge runs and sandboxes
under those names. What it finds becomes the lease record again: a runner
assigned to the job means `dispatched` or later; a bridge run or sandbox with
no runner means `dispatching`; nothing means the job is still pending. Two
records for one job collapse to the one GitHub assigned. A `hobo-` runner,
bridge run or sandbox that matches no candidate of any live job is an orphan
and is stopped after a grace period, as the orphan sweep does today.

Where the provider refuses a second resource with the same name (GitHub runner
names, Vercel named sandboxes), a duplicate create fails at the provider. Phase
4 verifies both against the live APIs before relying on it. A workflow-bridge
dispatch has no such guarantee; a duplicate bridge run finds its runner name
taken, exits, and is cancelled by reconcile.

## Mutual exclusion without a partition lock

Today every write takes one PostgreSQL row lock on the partition
([`postgres-store.ts`](../../packages/ci/src/postgres-store.ts), the
`SELECT … FOR UPDATE` on `hobo_ci_partitions` around lines 516–538), which
serializes the whole relay. It is replaced by per-key compare-and-set:

| Need | Key | Operation |
|---|---|---|
| One lease per job attempt | `lease:<leaseId>` holding the lease and a `version` | Create with set-if-absent; every transition is a compare-and-set on `version` |
| A job is taken once | `job:<repositoryId>:<jobId>:<runAttempt>` → lease id | `SET NX` with a TTL; holds `terminal` after completion |
| Account and offer concurrency limits | `inflight:<accountId>`: the account's in-flight lease ids, each with its offer and its budget hold | Compare-and-set on the index's version; admission adds an entry only if the limit holds |
| Crash recovery | The lease record's `intent: { kind, at }` | Written by compare-and-set before any external call; cleared with the outcome |
| Queue deadline | The lease record | Derived from the GitHub job's `created_at`, never from when the relay first saw it |

**Crash recovery keeps today's rule.** A function can die after recording its
intent and before recording the outcome. The step message scheduled for the
intent's cutoff (2 minutes, or 17 minutes for a Sandbox operation, as in
[`hosted-runtime.ts`](../../packages/ci-gh-actions/src/hosted-runtime.ts)
lines 362–414) finds the intent still open and marks the lease `uncertain`. An
uncertain lease is never retried blind: it is resolved by looking up its
deterministic names, adopting what exists, and re-admitting the job under the
next generation only when nothing exists and GitHub still reports it queued.
This replaces reading the latest intent events from the event journal.

**TTLs.** A lease key lives for the account's maximum runtime plus startup plus
one hour, refreshed on each transition. A terminal job marker lives 24 hours,
covering the queue's deduplication window; after that a re-read of the GitHub
job says it is completed.

## Sessions and OAuth state

Operator sessions become encrypted, authenticated cookies sealed with
`HOBO_CI_SESSION_KEY` (AES-GCM, with a key id so the key can rotate). The
cookie carries what `hobo_ci_oauth_sessions` holds today. OAuth `state` is
written with `SET NX` and a ten-minute TTL and consumed with a get-and-delete,
so it is single-use. A lost cache costs a sign-in that has to start again.

## Budgets and cost

- **Routing prefers** free offers, then prepaid ones, then the cheapest
  pay-as-you-go offer, as declared in config.
- **Budget caps are declared** in config per account and per offer.
- **Exposure** = provider usage the relay pulled on its last tick (Vercel's
  usage and billing API for Sandbox, GitHub's billing usage API for Actions
  minutes) + the holds of in-flight leases in the cache (each lease's maximum
  runtime times its offer's price). Admission to a priced offer requires
  exposure plus the new hold to stay under the cap.
- **No accounting records.** `spent_micros` stops being a field the relay
  writes; spend is what the provider reports.
- **Overrun is bounded by one pull interval**: spend outside the relay's own
  leases, and provider reporting lag, are not seen until the next pull.
- **Fail closed for money, open for free capacity.** When the in-flight index
  is missing (the cache was emptied), priced offers are paused until a rebuild
  pass has restored the holds; free and self-hosted offers keep admitting, as
  the [mesh](./ci-relay-mesh.md#what-stays-consistent) does.
- **Broker budget-policy accounts are not supported by the hosted relay.**
  They never were on Vercel: `composition.ts` builds `PostgresCiStore` without
  the shared-budget hooks, so such an account is refused there today. The
  Broker budget ledger library is unchanged.

## Config is read-only at runtime

The hosted relay stops serving every endpoint that writes configuration:

| Removed from the hosted relay | Replaced by |
|---|---|
| `PUT /v1/accounts/self/policy`, `PUT /v2/accounts/self/policy` | `hobo ci` writing the config document in the config service |
| `PUT /v2/accounts/self/providers` | Same |
| `POST /v2/accounts/self/signals` | Budget exposure pulled from providers ([above](#budgets-and-cost)) |
| `POST /v2/accounts/self/observations`, `POST /v2/accounts/self/rate-observations` | The relay pulling provider usage and rate data on its tick |
| `GET /v2/accounts/self/inbox/quarantined`, `POST /v2/accounts/self/inbox/<id>/retry` | Quarantine logged; redelivery from GitHub through `hobo ci` |
| `POST /v1/accounts/self/repositories/prepare`, `POST /v1/accounts/self/repositories/isolated-connect` and their operation reads | `hobo ci` acting against the config service and the GitHub API directly |

Read endpoints stay: the policy view (now read from config), in-flight leases,
installations (from the GitHub API, cached in memory), mesh nodes, the runtime
diagnostic, and lease reconcile (an operation on in-flight state, not on
config). The control plane is shared by every relay host; the Node service
behind `hobo ci serve` keeps its SQLite store and its write endpoints, which
this design does not change. The hosted composition passes a read-only config
source, and the shared control plane refuses writes against one.

**Config fencing moves to the writer.** Today a configuration change is a
compare-and-set on a revision, and active leases fence changes to a
connection's identity. Now each lease records the config revision and
identities it was admitted under and keeps them until it is terminal. `hobo ci`
refuses an identity change for a connection that has in-flight leases (it asks
the relay's read API) unless forced, and writes the new document with the
config service's own versioning. Admission keeps re-reading config after its
GitHub REST reads before committing demand, as `hosted-relay.ts` does now.

## MCP

`list_leases` and the pending-job views show in-flight work only; finished
jobs are GitHub's to show. `wait_for_events` reads a bounded change ring in
the cache: per account, the last few hundred changes, each with a TTL of one
hour. A wait reads the ring when it starts and then every 15 seconds; an
account with nothing in flight is answered at once with a hint to wait a
minute. A cursor older than the ring, or a ring that was lost, returns a
cursor reset, and the client re-reads the in-flight list.

## Sandbox egress and proxy caps

The authoritative egress counter and request-rate window for a Sandbox live in
that Sandbox's own proxy VM, which exists exactly as long as the Sandbox does
([sandbox egress](../../packages/ci-vercel/SANDBOX-EGRESS.md)). The proxy
enforces the cap itself and mirrors its counter to the cache about once a
minute for reporting. The proxy's session token is derived (an HMAC of the
lease id under a key from the config service) instead of stored, so
`hobo_ci_sandbox_proxies` has nothing left to hold.

## Correctness hazards and how each is kept

| Hazard | How it is kept |
|---|---|
| Double-provisioning | Job-taken marker (`SET NX`), then compare-and-set on the lease; before creating anything a step looks the deterministic name up; providers that enforce unique names refuse a duplicate. If the marker is lost, the name lookup still finds the first resource |
| Duplicate webhooks | Queue idempotency on the delivery id for 24 h; beyond that, every delivery is re-read against GitHub's REST view and the lease compare-and-set makes reprocessing a no-op |
| Budget overrun | Exposure = pulled usage + in-flight holds; overrun bounded by one pull interval; priced offers paused while holds are unknown |
| Sandbox egress cap | Enforced in the Sandbox's proxy VM, whose state lives and dies with the Sandbox; the cache only mirrors it |
| Lease fencing and crash recovery | Version compare-and-set on each lease; intent recorded before every external call; an open intent past its cutoff makes the lease uncertain; uncertainty resolved by name lookup, never by blind retry |
| Scanner exclusion | One lock per scanner and App (`SET NX` with a TTL a little longer than a scan pass); cursors in the cache; a lost cursor restarts from the newest page, bounded by five pages per tick and GitHub's three-day delivery history |
| GitHub API rate limits | Redelivery claims per delivery id with a 15-minute cooldown (`SET NX`), an App-wide limit of 20 redeliveries a minute and the queued-scan API budget as `INCR` windows with a TTL; a lost window allows at most one window's worth of extra calls |
| Config fencing | Each lease keeps the revision and identities it was admitted under; `hobo ci` refuses identity changes over in-flight leases; admission re-reads config after its REST checks |
| Readiness after cache loss | Worker-health keys missing means "no evidence yet", reported as starting, not failing; the next tick writes them |

## When GitHub is down

When GitHub Actions is down, no runner can start and no job can report. Keeping
state of our own does not buy availability for work GitHub triggers; it only
let the relay fail on its own, as it did on 2026-11-10. So the relay does not
try to be available while GitHub is not.

The cache buys resilience to partial outages, which are the common case:

- **Delayed or dropped webhooks.** GitHub does not retry a failed delivery on
  its own; its delivery history and redelivery are available for three days.
  The repair scanner redelivers failed deliveries from that history, and the
  queued-job scanner finds queued jobs whose delivery never arrived.
- **REST 5xx and rate limiting.** Steps are queue messages, so a failed call
  is retried by the queue with back-off; the lease records where it got to.
- **Instance restarts.** Nothing lives in the function. The next instance reads
  config and secrets, and the lease records and queue messages carry on.

## Cost model

Everything the relay attaches has a free allowance that this workload stays
inside. Exceeding one is cheap: the budget exists so the default deployment
costs nothing, not because an overrun is expensive.

| Service | Plan | What the relay uses |
|---|---|---|
| Vercel Functions, Queues, Schedules, Sandbox | The project's existing plan | As today; about eight queue messages per job (three or four webhook deliveries plus lifecycle steps) and one repair message per tick |
| Cache (Upstash via Marketplace) | Free: 256 MB, 500,000 commands a month | Below |
| Config service (Infisical Cloud) | Free | A read per cold start, a config refresh at most once a minute per warm instance |
| GitHub API | Included with the App | As today, plus listings during a rebuild |

**Cache commands per job (estimate):**

| Step | Commands |
|---|---|
| Intake: delivery seen-marker | 1 per delivery |
| Queued: job-taken marker, lease create, in-flight index read and compare-and-set, change ring append | 5 |
| Dispatch: read lease, record intent, record outcome, ring | 4 |
| Claim: read, compare-and-set, ring | 3 |
| Claim-timeout and reconcile checks | 2 |
| In progress: seen-marker, read, compare-and-set, ring | 4 |
| Completed: seen-marker, read, terminal marker, index read and compare-and-set, delete lease, ring | 7 |
| **Job on the workflow bridge** | **about 25** |
| Sandbox steps (create, start, stop: read and compare-and-set each) | 6 |
| Egress mirror, once a minute for a 10-minute run | 10 |
| **Sandbox job** | **about 45** |

**Cache commands per repair tick (every 15 minutes, about 2,900 a month):** two
scanner locks, two cursor reads and two writes, one or two API-budget
increments, the in-flight index, one read per in-flight lease, two usage
writes, one worker-health write: about 12 plus one per in-flight lease. With
five leases in flight on average, about 17 per tick, about 50,000 a month.

**MCP waits:** an idle account costs one command a minute per waiting client,
about 43,000 a month for an agent waiting all the time; a busy account about
four commands per 50-second wait.

At 100 jobs a day on the workflow bridge (about 75,000 commands), plus repair
ticks (about 50,000) and one agent waiting continuously (about 45,000 to
70,000), a month is about 200,000 commands: under half the free allowance.

## Options routed by budget

*Amendment of 2026-11-11 to [ADR-0179](./adr/hosted-relay-stateless.md#adr-0179).*

The relay makes two choices that money decides, and it makes both the way
HoBo asks users to make them: each option is a priced offer with a declared
capability, and HoBo's capability matching plus budget policy picks one. The
relay dogfoods the routing it sells. Every option is supported; none is
hard-wired.

The two choices are independent:

1. **Cache fleet** — which backend holds the relay's cross-job state, the
   `EphemeralStatePort`. This is the relay's *state* fleet. It is not the
   [compute fleet](#words-used-here), which this amendment does not touch.
2. **Lifecycle driver** — what advances each job's lifecycle (dispatch check,
   claim timeout, reconcile, Sandbox steps).

### Where each offer is recorded

Each option is a provider manifest (`hobo.provider-manifest/v1`, ADR-0178,
[`@hobo/provider-manifest`](../../packages/provider-manifest/README.md)) whose
`billing` section lowers through `toPricingCatalog` to an `@hobo/pricing`
`PricingCatalog` — one `ProviderProduct` with its meters, a `RateCard`, the
free allowance as included usage — and whose `capabilities.mappings` name the
profile the option satisfies. `hobo registry add` registers it, appending
`provider.Registered` and, for the catalog, `pricing.CatalogRegistered`
(`packages/hobo/src/pricing-catalog-store.ts`) to the registry stream. The
manifests live together, owned by the relay's deployment, in
`packages/ci-vercel/offers/`, and the phase 6 deploy registers them:

| Offer | Manifest | Product id | Meter (unit) | Capability profile |
|---|---|---|---|---|
| Upstash Redis free | `upstash-redis.provider.yaml` | `upstash.redis.free` | `commands` (command) | `kv.redis-compatible/v1` |
| Upstash Redis pay-as-you-go | same | `upstash.redis.payg` | `commands` (command) | `kv.redis-compatible/v1` |
| Aiven for Valkey free | `aiven-valkey.provider.yaml` | `aiven.valkey.free` | none (no command cap) | `kv.valkey/v1` |
| Turso free | `turso.provider.yaml` | `turso.libsql.free` | `rows-read`, `rows-written` (row) | `kv.ephemeral-state/v1` |
| Self-hosted Valkey | `self-hosted-valkey.provider.yaml` | `self-hosted.valkey` | none (zero provider cost) | `kv.valkey/v1` |
| Vercel Blob (private) | `vercel-blob.provider.yaml` | `vercel.blob.private` | TODO: unverified | `kv.ephemeral-state/v1` |
| Vercel Queues lifecycle driver | `vercel-queues.provider.yaml` | `vercel.queues` | `messages` (message) | `lifecycle.lease-driver/v1` |
| Vercel Workflows, managed World | `vercel-workflows.provider.yaml` | `vercel.workflows.managed` | `events` (event) | `lifecycle.lease-driver/v1` |

`kv.ephemeral-state/v1` (refining `kv.key-value/v1`) and
`lifecycle.lease-driver/v1` are new profiles, proposed here and defined in
phase 5: the first next to `KV_REDIS_COMPATIBLE_PROFILE` in
`@hobo/kv-redis-compatible` (`src/requirement.ts`), satisfied by any binding
that passes `EPHEMERAL_STATE_CONFORMANCE_CASES`; the second with the
`LeaseLifecycleDriver` port. The Redis-protocol offers satisfy
`kv.ephemeral-state/v1` through the shared Lua binding, so the relay requires
only that profile. Budget caps are declared per offer in the config service,
as compute offers' caps already are ([Budgets and cost](#budgets-and-cost)).

### Cache fleet options

All prices and limits below are as the vendor stated them on 2026-11-11 and
must be re-checked at provisioning.

| Backend | Free allowance | When exhausted | Beyond free | Reach from `iad1` | Binding |
|---|---|---|---|---|---|
| **Upstash Redis** ([pricing](https://upstash.com/pricing/redis)) | 500,000 commands a month, 256 MB | Blocked | Pay-as-you-go plan: $0.20 per 100,000 commands | REST; pick region `us-east-1`, next to `iad1` | `@hobo/provider-upstash` |
| **Aiven for Valkey** ([free tier](https://aiven.io/docs/products/valkey/concepts/valkey-free-tier), [free plan](https://aiven.io/docs/platform/concepts/free-plan)) | 1 GB RAM (about 512 MB usable), single node, no command cap | — | Paid plans not modelled here | TCP; region not selectable on the free plan; powered off when idle | `@hobo/kv-redis-compatible/resp`; connection URL from the config service |
| **Turso** ([pricing](https://turso.tech/pricing)) | 500 million rows read, 10 million rows written a month | Blocked | Paid plans not modelled here | HTTPS from a function | `@hobo/provider-turso`; already attached to the project |
| **Self-hosted Valkey** | Whatever the host has | — | Zero provider cost | Any reachable host | `@hobo/kv-redis-compatible/resp` |
| **Vercel Blob, private** ([Blob](https://vercel.com/docs/vercel-blob), [SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), [private storage](https://vercel.com/docs/vercel-blob/private-storage)) | TODO: pricing not verified | TODO | TODO | First-party; OIDC (`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`), no stored token | Not built (below) |

**Vercel Blob is a feasible first-party backend.** Its SDK documents
conditional writes: `put` without `allowOverwrite` fails when the blob exists
(putIfAbsent); `put(..., { allowOverwrite: true, ifMatch: etag })` and
`ifMatch` on rename and delete throw `BlobPreconditionFailedError` on a
mismatch (compareAndSet, versioned delete); and a private read with
`get(pathname, { access: "private", useCache: false })` bypasses the CDN for
read-after-write. So an `EphemeralStatePort` over private Blob maps
`putIfAbsent` to a non-overwriting put, `compareAndSet` to `ifMatch`,
`increment` to a compare-and-set loop, and TTL to an expiry stored in the
object with lazy deletion. It is not built yet and must pass the conformance
suite like any binding. The Blob store must be created and connected by the
owner or by the CI deploy step: the Vercel MCP connector's identity is refused
(403). It is not a candidate store for a custom Workflow World: a World
needs an append-only log with dense ids and transactions
([below](#lifecycle-driver-options)).
([below](#lifecycle-driver-options)).

**Vercel Runtime Cache is an L1, never the authority.** `getCache()` from
`@vercel/functions` is a first-party regional key-value cache with `get`,
`set`, `delete`, TTLs and tags; `expireTag` invalidates globally in about
300 ms, and entries survive deployments
([Runtime Cache](https://vercel.com/docs/caching/runtime-cache),
[`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)).
It is documented as regional and ephemeral, with no compare-and-set or atomic
increment. The relay may put it in front of the active backend as a
read-through layer for values that tolerate staleness, to cut billed commands
and rows on a paid tier; it is never used for exclusion, versions or counters.

**Excluded, with reasons:**

- **Redis Cloud free:** 30 MB and 100 operations a second, and whether the
  free database offers TLS is unclear.
- **Valkey hosted on Vercel.** A daemon does not accept inbound HTTP or TCP
  ([daemon limits](https://vercel.com/docs/daemons/limits)). A container
  service is HTTP-only, autoscaled with no documented single-instance cap, and
  scales to zero after five idle minutes
  ([container runtime](https://vercel.com/docs/functions/runtimes/container)),
  which a single-writer cache cannot survive. A daemon would also cost about
  $0.0212 per GB-hour, about $15.50 a month for 1 GiB of memory alone
  ([pricing](https://vercel.com/pricing)), more than every option above.

**Global Config** (formerly Edge Config) is first-party, read-optimised
configuration: written through the API or CLI with a Vercel token and read by
apps with a read token ([Global Config](https://vercel.com/docs/global-config)).
It is an optional first-party source for the relay's *configuration*, next to
the config service. It is not a runtime store: the relay never writes it.

### Exactly one cache at a time

Compare-and-set is correct only within one backend, so exactly one cache is
active. Selection reuses the engine-neutral parts of the relay database
fleet's policy in `@hobo/data-postgres` (`src/fleet/`):

- **`AssignmentReplica` and `resolveAssignment`** (`assignment.ts`): an
  assignment log — epoch, active backend, sealed flag, reason — replicated on
  every configured cache backend, and current only when a majority of the
  configured backends hold the same entry for the highest epoch. A cache-side
  replica implements `read` as a `get` of one key and `accept` as a
  `compareAndSet` that appends the entry, so the log needs nothing but the
  port. The key carries a TTL (at most 30 days) and is rewritten on each
  decision and on a schedule well inside it.
- **`decideFleet`** (`policy.ts`), with its usage periods (`usage.ts`): a
  *planned switch* when the active backend is projected to exhaust a hard
  allowance or is no longer affordable under the budget, and a *failover* when
  it is quota-exhausted or unreachable past a threshold.

Those pieces never mention SQL. Phase 4c proposes moving them, with
`fleetMajority`, the failure classes and the billing-period helpers, from
`@hobo/data-postgres` into an engine-neutral package that `@hobo/data-postgres`
re-exports; this amendment moves no code.

**Switching is safe because cache loss is tolerated.** The new backend starts
cold. The relay rebuilds in-flight leases from GitHub and Vercel by
deterministic names ([GitHub is the system of record](#github-is-the-system-of-record-for-jobs)),
and nothing is copied between caches — unlike the database fleet, which had to
copy because its state was the only copy. While instances learn the new epoch
(at most one assignment refresh), two instances may write different caches;
during that window double-provisioning is prevented by the same name lookup
that protects the [degraded floor](#degraded-floor-no-cache-reachable). Priced
offers pause until the rebuild has restored the in-flight holds, as after any
cache loss.

### Lifecycle driver options

A `LeaseLifecycleDriver` port, with two implementations that call the same
relay transition logic against the same store. The driver is chosen **per job
at admission** and is sticky for that job, recorded on its lease, so switching
drivers never strands in-flight work: running jobs finish on the driver they
started with, and new jobs take the new one.

- **Vercel Queues** (the driver ADR-0179 already describes): each lease step is
  a delayed message with idempotency key `${leaseId}:${step}:${n}`.
- **Vercel Workflows**: one durable run per job, started with
  `experimental_hook: { token: "job:<repo>:<job>:<attempt>" }` so that a
  second start for the same job attempt resolves to the existing run
  (exactly-once starts). Verified GitHub webhooks resume it through
  `resumeHook`; timeouts are `sleep()`; steps are retried durably; the run
  dedupes redelivered events itself. Sources:
  [Workflows](https://vercel.com/docs/workflows),
  [pricing](https://vercel.com/docs/workflows/pricing),
  [idempotency](https://workflow-sdk.dev/docs/foundations/idempotency),
  [hooks](https://workflow-sdk.dev/docs/foundations/hooks).
  A run is pinned to the deployment that started it, so a deployment with
  in-flight runs is never deleted.

**What the Workflow SDK spike found** (branch `claude/relay-workflow-spike`,
`packages/ci-vercel/src/workflow-spike/README.md`):

- **Build.** Plain `api/` Vercel Functions have no documented Workflows build
  integration; frameworks do, and Express, Hono and Fastify build through
  Nitro. Production needs a Nitro entry in `@hobo/ci-vercel`, or a custom
  `BaseBuilder` that emits one flow function on `__wkf_workflow_*`.
- **Versions.** The atomic `start({ experimental_hook })` needs `workflow`
  5.4.0 or later (released 2026-11-04, so usable under the repository's
  two-week pin rule from 2026-11-18); 5.2.x silently ignores the option, which
  would lose the exactly-once start without an error. `@hobo/ci-vercel` also
  needs `zod` 4.5 or later.
- **Platform.** "Enable access to System Environment Variables" must be on;
  runs are pinned to their deployment; a step runs for at most about 800 s.
- **Events.** About 20 events a relay job on the happy path, planned at 22,
  by the counting rule on the [pricing page](https://vercel.com/docs/workflows/pricing);
  15–19 measured on the Local World.

Workflows run on a **World**, the backend that stores runs and delivers steps:

- **Vercel's managed World** bills events: $20 per million ($0.02 per
  thousand) on Pro ([pricing](https://vercel.com/docs/workflows/pricing)),
  plus data written (about $1–3 a month at these volumes), queue operations
  and compute.
- **A self-hosted World is not viable on Vercel today.** "The Postgres World
  needs a long-lived process to run its worker, so it does not work on
  serverless platforms" and "is not compatible with Vercel deployments"
  ([Postgres World](https://workflow-sdk.dev/worlds/postgres)); the
  agent-harness self-hosting guide
  ([self-hosting](https://vercel.com/docs/agent-harnesses/self-hosting)) is
  for running outside Vercel. Community Redis, Upstash and Turso Worlds exist
  but pin `@workflow/world` 4.x and do not work with `workflow` 5
  ([Worlds](https://workflow-sdk.dev/worlds)). A custom World needs an
  append-only durable log with dense ids, unique hook tokens and transactions
  ([building a World](https://workflow-sdk.dev/worlds/building-a-world)): a
  loss-tolerant `EphemeralStatePort` cannot back it. libSQL plus Vercel Queues
  or QStash could, at an estimated 2–4 engineer-weeks plus tracking the spec.
  It is a future option, not a current one.

So the lifecycle-driver offers, in budget order: the Queue driver (with a
free-tier cache), then Workflows on Vercel's managed World, paid per event. A
self-hosted World joins the order only once one runs on the relay's platform.

### Preference, metering and switching

- **Order:** free, then prepaid, then the cheapest pay-as-you-go offer, per
  provider — the routing rule compute offers already follow.
- **Metering per backend and driver, against its own allowance:** the command
  meter (`meterExecutor`, `commandBudgetStatus` in
  `@hobo/kv-redis-compatible`) for Redis-protocol caches; the request and rows
  meter (`meterLibsqlClient`, `createLibsqlUsageMeter` in
  `@hobo/provider-turso`) for libSQL; an event estimate per run for
  Workflows (planned at 22 a job); message counts for Queues.
- **Switch before exhaustion, with hysteresis:** `decideFleet` switches on a
  *projected* exhaustion inside the period, and the relay does not switch back
  until the previous backend's projection is comfortably inside its allowance
  (for example below 80 % for the rest of the period) or a new period starts,
  so it does not flap at a boundary.
- **Budget caps are declared in config,** per offer, in the config service; a
  pay-as-you-go offer is admitted only while its exposure stays under its cap.

### Cost at measured volume

GitHub Actions history sampled on 2026-11-11 showed about 155 jobs an hour in a
busy window, an upper range of 1,800–3,700 relay jobs a day. The cache store
measured 62–73 commands a job (the meter in PR #1890). The Workflows driver
costs about 20 events a job on the happy path, planned at 22 (the spike). Months are 30 days;
cache figures use 73 commands a job plus about 120,000 a month of repair ticks
and one continuously waiting MCP client ([cost model](#cost-model)).

| Jobs a day | 100 | 1,000 | 3,700 |
|---|---|---|---|
| Jobs a month | 3,000 | 30,000 | 111,000 |
| Cache commands a month | about 339,000 | about 2.31 million | about 8.22 million |
| Upstash Redis | $0 (free) | free blocked at 500,000; pay-as-you-go ≤ $4.62 | free blocked; pay-as-you-go ≤ $16.45 |
| Aiven for Valkey free | $0 | $0 | $0 |
| Turso free: rows written ≤ commands, plus purges | $0 (≤ 0.34 M of 10 M) | $0 (≤ 2.3 M of 10 M) | $0 while ≤ 10 M: 8.2 M plus purges, near the cap; measure |
| Self-hosted Valkey | $0 provider cost | $0 | $0 |
| Vercel Blob | TODO: pricing unverified | TODO | TODO |
| Workflows, managed World, 22 events a job (events only) | about $1.32 | about $13.20 | about $48.84 |
| Queue driver (about 8 messages a job) | Queues pricing not re-verified in this amendment (TODO) | TODO | TODO |

Workflows figures are events only; data written adds about $1–3 a month, plus
queue operations and compute. The pay-as-you-go figures bill every command, an upper bound: whether
Upstash's pay-as-you-go plan includes the free allowance is not verified.
Turso's rows read (at most one per command, plus ring windows) stay far below
500 million at every volume; rows written are the constraint, and the
per-operation rows are upper bounds derived from Turso's definitions, not
measured ([`@hobo/provider-turso`](../../packages/providers/provider-turso/README.md#rows-read-and-written)).
At 3,700 jobs a day the free plans that hold are Aiven, self-hosted Valkey and
probably Turso; Upstash needs its pay-as-you-go plan.

### Degraded floor: no cache reachable

When no cache backend is reachable the relay keeps serving rather than
answering 503. Without the job-taken marker it relies on GitHub: before
creating a JIT runner it lists the repository's or organization's runners and
looks for the deterministic name `hobo-<leaseId>`; if one exists it adopts it
instead of creating another. GitHub documents `409 Conflict` for the
generate-jitconfig endpoint
([self-hosted runners REST API](https://docs.github.com/en/rest/actions/self-hosted-runners)),
but whether a duplicate runner name is what returns it is **unverified** and
must be tested against the real API (phase 4e) before the floor relies on it.
In the floor, priced offers stay paused, as whenever holds are unknown.

## One-time owner actions

1. Create an Infisical organization on the free plan and one machine identity
   that trusts this repository's GitHub Actions OIDC, bound to the protected
   deployment environment. The deploy workflow uses it to create the relay's
   own read-only identity (trusting Vercel's OIDC issuer for this team and
   project); if the free plan does not allow that through the API, the owner
   creates the second identity by hand in the same sitting.
2. Store a Vercel deploy token in Infisical, where only the admin identity can
   read it.
3. Re-create the GitHub App once through the HoBo CLI, so its private key,
   webhook secret and client secret go straight into Infisical and are never
   copied by hand.
4. Create an Aiven for Valkey service on the free plan and store its
   connection URL in the config service, so the cache fleet has a free
   backend with no command cap ([options](#cache-fleet-options)). The URL is
   a secret; it never passes through the repository or a terminal log.

Everything else, including attaching the cache through the Marketplace, is done
by the deployment.

## Deployment through HoBo

The relay's deployment config is HoBo's own app model: the Bindle in
[`src/bindle.ts`](../../packages/ci-vercel/src/bindle.ts) plus a Yard and Camp
that target Vercel. It declares bindings for the cache
(`kv.ephemeral-state/v1`, served by whichever cache-fleet backend the budget
policy assigns: the Upstash and Turso Marketplace integrations, Aiven, or a
self-hosted Valkey), the queue, the schedule, and the config service; the `data` resource for
PostgreSQL goes away. `hobo ci deploy` plans from that declaration instead of
hardcoding Vercel in `programFor`
([`ci-relay-deploy.ts`](../../packages/hobo/src/ci-relay-deploy.ts)). A
workflow on `main` runs it: it authenticates to Infisical with GitHub OIDC,
reads the Vercel deploy credential, and deploys the commit it was triggered
by. There are no manual deploys.

**Pay only for what is used.** The relay's deployment includes only what it
uses. Neon and its Vercel integration and the Neon-hosted config broker are
disconnected. Turso, attached to the project and unused when ADR-0179 was
accepted, stays: it is one of the [cache-fleet options](#options-routed-by-budget),
on its free plan.

## Delivery plan

| Phase | Delivers | Done when |
|---|---|---|
| 1 | This design and ADR-0179 | Merged |
| 2 | The relay's cache port over `@hobo/kv-redis-compatible` (TTL, compare-and-set, increment), an in-memory implementation and an Upstash REST implementation, each passing the kv conformance suite; a Valkey implementation over RESP | The suite passes for all three; the in-memory one runs in every relay test |
| 2b | A libSQL (Turso) implementation of the port in `@hobo/provider-turso`, and the [Options routed by budget](#options-routed-by-budget) amendment | The 24 conformance cases pass on `file:` and `:memory:` databases, including clients in separate threads on one file; rows read and written per operation documented |
| 3 | The config-service client (Infisical OIDC Auth with the Vercel token; GCP Secret Manager behind the same port), and GitHub App creation from `hobo ci` that writes the App's credentials straight into the config service | The relay starts from Infisical with no secret in its environment; App creation lands credentials in custody without passing through the terminal |
| 4 | A relay store on the cache: deterministic lease ids, per-key compare-and-set, the in-flight index, intent timestamps; Queue intake with delivery-id idempotency; per-lease step messages; rebuild by name | The relay's store contract tests pass on the cache store; killing the cache mid-job loses no job; a duplicated delivery provisions once; GitHub and Vercel name uniqueness verified live |
| 4b | `RelayCacheStore` wired into `@hobo/ci-vercel` with the Queue lifecycle driver behind the `LeaseLifecycleDriver` port | The hosted relay runs a job end to end on the cache store in a preview deployment |
| 4c | Cache-fleet selection: the assignment log on every cache backend through the port's compare-and-set, `resolveAssignment` and `decideFleet` moved from `@hobo/data-postgres` to an engine-neutral package (which also keeps `@hobo/data-postgres` out of the relay bundle for phase 7), shared usage metering (commands, rows), budget-policy switching with hysteresis | A projected exhaustion switches backends before the allowance runs out; a lost backend fails over; the relay rebuilds on the new backend with no lost job |
| 4d | The Workflows lifecycle driver on Vercel's managed World (exactly-once starts by hook token, `resumeHook` from verified webhooks, `sleep()` timeouts), built through a Nitro entry in `@hobo/ci-vercel` or a custom `BaseBuilder`; `workflow` ≥ 5.4.0 (pinnable from 2026-11-18) and `zod` ≥ 4.5; driver chosen per job at admission. Not before 2026-11-18 | A job runs end to end on each driver; switching drivers leaves in-flight jobs on theirs; a repeated start for one job attempt yields one run |
| 4e | The degraded GitHub-only floor | Duplicate JIT runner names verified against the real API (409 or not); with every cache unreachable, a duplicated delivery still provisions once |
| 5 | Helpers on the cache: repair scanners (locks, cursors, rate windows), cookie sessions and OAuth state, bootstrap and onboarding without the platform-App tables, the MCP change ring, provider usage pulls for budgets. The cache-fleet and lifecycle-driver offers as provider manifests in `packages/ci-vercel/offers/` lowered into the HoBo pricing catalog, the `kv.ephemeral-state/v1` and `lifecycle.lease-driver/v1` profiles, selection by capability and budget, and rebalancing | Each helper's tests pass on the in-memory cache; the removed control endpoints answer 404 on the hosted relay; every option is a registered priced offer and the selection is a logged policy decision |
| 6 | Deployment config (Bindle, Yard, Camp) with cache, queue, schedule and config-service bindings; `hobo ci deploy` planning from it; the deploy workflow on `main`; Marketplace cache provisioning | A merge to `main` deploys the relay with no manual step and no secret in the repository |
| 7 | Removals ([itemized](#phase-7-removals)) | The hosted relay's bundle has no `pg`, no `@neon/functions` and no `@hobo/data-postgres`; the removed files are gone |
| 8 | Cutover and an end-to-end job | A real `runs-on: hobo` job runs through the new relay; Neon and the broker are disconnected |

**Phase 4 so far.** 4a: the store on the cache (`@hobo/ci-gh-actions/relay-cache`).
4b: `composeStatelessRelay` in `@hobo/ci-vercel`: the cache backend chosen from
the deployment's bindings (Upstash REST, then Valkey; in memory only off Vercel)
behind one seam, `selectCacheBackend`, with every command metered against a
monthly allowance; intake on the `hobo-ci-intake` topic keyed by delivery id;
per-lease steps on `hobo-ci-lease-steps` keyed `${leaseId}:${step}:${n}`, each
rung at a fixed offset from the lease's creation so chains of one lease
collapse; the 15-minute repair tick as backstop with a rebuild pass for lost
holds; the control plane's configuration writes answering 410. End-to-end tests
on the in-memory cache cover a Sandbox job from webhook to settlement,
duplicate deliveries provisioning once, and the cache wiped mid-job (the lease
rebuilt by name, the running job adopted rather than stopped). Still open:
policy-driven cache selection (4c); settling a rebuilt Sandbox lease, whose
proxy meters were in the lost cache (it stays `uncertain` until its record
lapses); name uniqueness at GitHub and Vercel verified live. A Sandbox job
costs 99 cache commands through the whole composition, against the estimate of
about 45 above; the store's own path dropped from 62 to 43.

### Phase 7 removals

`packages/ci-vercel`:

- `src/`: `database-connections.ts`, `database-discovery.ts`,
  `database-fleet.ts`, `database-fleet-config.ts`,
  `database-fleet-conformance.ts`, `database-fleet-executor.ts`,
  `database-selection.ts`, `database-selection-import.ts`,
  `database-selection-marker.ts`, `database-selection-relay.ts`,
  `relay-schema.ts`, `neon-secret-broker.ts`, `neon-broker-entry.ts`,
  `neon-trigger.ts`, `runtime-config-client.ts`; the Postgres read store in
  `worker-health.ts` (moves to the cache); the Postgres wiring in
  `composition.ts`, `bootstrap-entry.ts`, `sandbox-composition.ts` and
  `entry.ts` (rewired, not deleted).
- `db/` (schema, source, migrations, the embedded-DDL lock), `tsconfig.db.json`,
  `deploy/postgres/`.
- `scripts/`: `bootstrap-postgres-contract.ts`,
  `database-connections-postgres-contract.ts`, `database-fleet-proof.ts`,
  `sandbox-pg-contract.ts`, `worker-postgres-contract.ts`.
- `test/`: `database-connections.test.ts`, `database-discovery.test.ts`,
  `database-fleet*.test.ts`, `database-fleet-harness.ts`,
  `database-selection*.test.ts`, `neon-secret-broker.test.ts`,
  `neon-trigger.test.ts`, `postgres-schema.test.ts`, `relay-schema.test.ts`,
  `runtime-config-client.test.ts`; the Postgres cases of
  `worker-health.test.ts`.
- `package.json`: `pg`, `@types/pg`, `@neon/functions`, `@hobo/data-postgres`,
  the Drizzle dev dependencies and the `db:*` scripts.

`packages/ci`:

- `src/postgres-store.ts` (`PostgresCiStore`), `src/schema-migrations.ts`, the
  `./postgres` and `./schema-migrations` exports.
- `db/` (schema, source, migrations, tooling), `tsconfig.db.json`,
  `scripts/postgres-contract.ts`.
- `test/`: `postgres-authoritative-admission.test.ts`,
  `postgres-schema.test.ts`, `postgres-schema-lineage.test.ts`,
  `schema-tooling.test.ts`.
- `package.json`: `pg`, `@types/pg`, Drizzle dev dependencies, `db:*` scripts.

`packages/ci-gh-actions`:

- `src/`: `app-registration-postgres.ts`, `github-oauth-session-postgres.ts`,
  `hosted-schema.ts`, `postgres-session-lock.ts`,
  `isolated-worker/postgres-pool.ts`; the Postgres stores inside
  `webhook-repair.ts`, `queued-job-repair.ts`, `hosted-app-bootstrap.ts` and
  `hosted-app-onboarding.ts` (moved onto the cache in phase 5); the
  `HOBO_CI_STORE=postgres` branch of `isolated-worker/worker-store.ts` (the box
  worker's shared Postgres partition option).
- `db/`, `tsconfig.db.json`; `scripts/onboarding-postgres-contract.ts`,
  `owner-bootstrap-postgres-contract.ts`,
  `queued-job-repair-postgres-contract.ts`.
- `test/`: `app-registration-postgres.test.ts`, `hosted-schema.test.ts`,
  `pinned-postgres-testcontainers.test.ts`, `postgres-schema.test.ts`,
  `postgres-schema-lineage.test.ts`, `postgres-session-lock.test.ts`; the
  Postgres leg of `ci-store-contract.test.ts` (its SQLite leg stays).
- `package.json`: `pg`, `@types/pg`, Drizzle dev dependencies, `db:*` scripts.

`packages/hobo`: the `store: { kind: "postgres" }` option of `hobo ci serve`
(`src/ci-serve.ts`) and its documentation in `CI.md`.

Documentation: the superseded sections in `packages/ci-vercel/README.md`,
`packages/ci/README.md`, `packages/ci-gh-actions/README.md` and
`packages/ci/RUNNER-QUEUE.md` are deleted rather than kept with a banner.

### Phase 8 cutover

1. Deploy the new relay to a preview environment with its own cache prefix and
   run a job end to end against a test repository.
2. Let the old relay drain: stop admitting, wait until no lease is in flight.
   Old leases have random ids, so the new relay would treat their runners as
   orphans; cutting over with leases in flight would stop them.
3. Point the GitHub App's webhook at the new production deployment. Old
   deployments' queue consumers already forward to the canonical URL.
4. Run a `runs-on: hobo` job on `main` through the new relay.
5. Disconnect Neon and its Vercel integration and delete the Neon broker
   project. Turso stays as a cache-fleet option.

## Former tables and their replacements

Every `hobo_ci_*` table the hosted relay used, and where its job goes:

| Table | Owner | Held | Replaced by |
|---|---|---|---|
| `hobo_ci_inbox` | `@hobo/ci` | Verified webhook deliveries awaiting admission | Vercel Queue intake with `idempotencyKey` = delivery id |
| `hobo_ci_events` | `@hobo/ci` | The CI event journal | Structured logs and CloudEvents (`HOBO_CI_EVENTS_URL`) for history; the MCP change ring for live changes; GitHub for job history |
| `hobo_ci_leases` | `@hobo/ci` | Lease projection | `lease:<leaseId>` in the cache, rebuilt by name |
| `hobo_ci_terminal_jobs` | `@hobo/ci` | Tombstones stopping re-admission | Job-taken marker holding `terminal` for 24 h, then GitHub's REST view |
| `hobo_ci_assigned_jobs` | `@hobo/ci` | Job-to-runner assignment | The GitHub job's `runner_name`, copied onto the lease record |
| `hobo_ci_pending_jobs` | `@hobo/ci` | Queued jobs awaiting capacity | In-flight index entries in `pending` plus a delayed step message; deadline from `created_at` |
| `hobo_ci_configuration` | `@hobo/ci` | Revisioned configuration | The config document in the config service |
| `hobo_ci_control_records` | `@hobo/ci` | Onboarding and setup operation records | `hobo ci` against the config service and GitHub; nothing on the relay |
| `hobo_ci_sandbox_egress` | `@hobo/ci` | Egress cap and bytes used per Sandbox | The Sandbox's proxy VM, mirrored to the cache |
| `hobo_ci_sandbox_proxies` | `@hobo/ci` | Proxy sessions and token digests | A token derived from the lease id; nothing stored |
| `hobo_ci_sandbox_proxy_requests` | `@hobo/ci` | Proxy request-rate window | The proxy VM's own memory |
| `hobo_ci_partitions` | `@hobo/ci` | The partition row everything locked | Removed; per-key compare-and-set |
| `hobo_ci_snapshot_backups` | `@hobo/ci` | SQLite snapshots imported into Postgres | Removed |
| `hobo_ci_app_states` | `@hobo/ci-gh-actions` | App-manifest flow state | App created from `hobo ci`; any single-use state is `SET NX` with a TTL |
| `hobo_ci_app_credentials` | `@hobo/ci-gh-actions` | The App's private key and secrets | Secrets in the config service |
| `hobo_ci_app_installations` | `@hobo/ci-gh-actions` | Known installations | The GitHub API (App JWT), cached in memory |
| `hobo_ci_oauth_states` | `@hobo/ci-gh-actions` | OAuth `state` | `SET NX` with a ten-minute TTL, consumed with get-and-delete |
| `hobo_ci_oauth_sessions` | `@hobo/ci-gh-actions` | Operator sessions | Encrypted signed cookies |
| `hobo_ci_platform_app` | `@hobo/ci-gh-actions` | The platform-App bootstrap fence | App creation from `hobo ci` into the config service |
| `hobo_ci_platform_app_attempts` | `@hobo/ci-gh-actions` | Bootstrap attempts | Removed with the in-relay bootstrap |
| `hobo_ci_platform_app_invitations` | `@hobo/ci-gh-actions` | Onboarding invitations | The onboarding token in the config service, with its expiry; a consumed-marker `SET NX` in the cache; `hobo ci` rotates the token after use |
| `hobo_ci_queued_scans` | `@hobo/ci-gh-actions` | Queued-job scan cursors | Cursor keys in the cache |
| `hobo_ci_queued_api_budget` | `@hobo/ci-gh-actions` | GitHub API calls spent by the queued scan | `INCR` windows with a TTL |
| `hobo_ci_webhook_repairs` | `@hobo/ci-gh-actions` | Per-delivery redelivery claims | `SET NX` with a 15-minute TTL per delivery id |
| `hobo_ci_webhook_successes` | `@hobo/ci-gh-actions` | Deliveries known to have succeeded (four days) | A seen-marker per delivery id with a four-day TTL, and GitHub's own delivery status |
| `hobo_ci_webhook_scan_cursors` | `@hobo/ci-gh-actions` | Delivery-history scan cursors | Cursor keys in the cache |
| `hobo_ci_worker_health` | `@hobo/ci-vercel` | Last success and failure per worker | Keys in the cache with a TTL; missing reads as "starting" |
| `hobo_ci_database_probes` | `@hobo/ci-vercel` | Database reachability probes | Removed |
| `hobo_ci_store_selection` | `@hobo/ci-vercel` | Which attached store was chosen | Removed |
| `hobo_ci_fleet_assignments`, `hobo_ci_fleet_watermarks`, `hobo_ci_fleet_usage` | relay database fleet over `@hobo/data-postgres` | Writer register, replication watermarks, per-backend usage | Removed with the relay database fleet |
| `hobo_ci_schema_migrations` | `@hobo/ci` tooling | The migration ledger | Removed |

## Out of scope and unchanged

- **The compute fleet:** the relay mesh, capacity, runner routing and
  balancing, NATS mesh state, `packages/ci/src/fleet/*`,
  `packages/ci-gh-actions/src/fleet-*.ts`, `mesh-nats.ts`.
- **`SqliteCiStore`** for local box workers and `hobo ci serve`, and the Node
  service's own control endpoints.
- **`@hobo/data-postgres`**, including its fleet module. It is a library for
  user workloads; the hosted relay only stops depending on it.
- **The Broker budget ledger library.**
- **The box worker's pull admission** and everything in
  [CI Relay Mesh](./ci-relay-mesh.md) about nodes, claims and trust.

## Open questions

- **Live name uniqueness.** Whether GitHub refuses a second JIT runner with the
  same name in every scope the relay uses, and whether Vercel refuses a second
  named Sandbox, is checked in phase 4 before double-provisioning relies on it.
- **Provider usage latency.** How far behind Vercel's and GitHub's usage APIs
  run sets the real overrun bound; phase 5 measures it.
- **Infisical free-plan limits** on machine identities and API rate are
  checked when the organization is created.
- **Preview deployments.** Whether the Marketplace integration gives preview a
  separate cache database, or only a key prefix separates them.

## Related

[ADR-0179](./adr/hosted-relay-stateless.md#adr-0179) ·
[CI Relay Mesh](./ci-relay-mesh.md) ·
[`@hobo/ci-vercel`](../../packages/ci-vercel/README.md) ·
[`@hobo/kv-redis-compatible`](../../packages/kv-redis-compatible/README.md) ·
[Shared budget policy](./shared-budget-policy.md)
