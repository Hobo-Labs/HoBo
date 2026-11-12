# `@hobo/storage-postgres`

The multi-node durable EventStore: `DurableEventStore` (from `@hobo/core`) on
PostgreSQL 16 or newer. Plan 0024 D16 / WP17 closes defect C11 ("no
multi-node fenced store").

SQLite (`@hobo/storage-sqlite`) stays the default for one node. PostgreSQL is
required when `hobo serve cd` runs more than one replica, or when an agent
fleet runs more than one Station process (plan 0024 R6). Store selection is
WP18's composition (`composeContinuousDelivery`).

```ts
import { createPostgresEventStore } from "@hobo/storage-postgres";

const store = createPostgresEventStore({
  config: { connectionString: process.env.HOBO_STORE_POSTGRES_URL ?? "", schema: "hobo_cd" },
  clock,            // injected; every stored timestamp comes from it (I8)
  telemetry,        // a CD TelemetrySink fits as-is
});
await store.ready(); // optional: connect and migrate now instead of on first use
```

`postgresStoreConfigFromEnv(process.env)` reads the same settings from
`HOBO_STORE_POSTGRES_*` variables.

## What it guarantees

| Property | How |
|---|---|
| Expected-version append | The stream row is locked (`SELECT … FOR UPDATE`) and `expectedSeq` compared under the lock; a stale value is `OPTIMISTIC_SEQUENCE_CONFLICT` and nothing is written. |
| Fenced single writer per stream | `owner_epoch` on the stream row, with `@hobo/storage-sqlite` semantics: the first fenced append enters fenced mode; a lower fence is `STALE_FENCE`; an unfenced write is `MISSING_FENCE`. |
| `readAll` by global position, never skipping | Positions come from one `partition_head` row, locked just before the insert and held to commit. They are gapless and become visible in order, so a reader paging by position never passes over a position that commits later. |
| Atomic staged effects | Queue, actor-signal, timer, cron and outbox effects are inserted in the commit's transaction, with the same identities and dedupe as SQLite. |
| Fenced subscription leases | `claimSubscription` grants with a fence token that only ever increases (also across release); a live lease held by another holder is `SUBSCRIPTION_LEASE_CONFLICT` (`lease-held`). Renew, release and checkpoint require the current fence. |
| No lost or duplicate checkpoint | `commitCheckpoint` runs under the lease row lock, is forward-only (`CHECKPOINT_REGRESSION`), and appends each advance once to `checkpoint_log`, the audit trail of every movement. |
| Snapshots, fold, quarantine | As runtime-local: a poison event is quarantined once, durably, even across restarts. |
| Idempotency | Per-stream idempotency keys (unique index) and in-batch duplicates are returned as `deduped`. |
| Live wake across nodes | `subscribe` handlers run in position order for events from any process; commits `pg_notify`, and the store `LISTEN`s on a dedicated connection. Durable consumers use leases and `readAll` instead. |
| Deterministic ids | Event ids are ULID-shaped, derived from timestamp and global position: unique across processes, with no RNG. |

`getStreamHead` (synchronous in the port) is not provided, because a server
cannot answer synchronously. Callers fall back to reading the stream;
`loadStreamHead` is the asynchronous equivalent.

## Architecture

This is the event store under HoBo's event-sourced CQRS control plane (AGENTS.md
architecture rules). A command handler, such as an actor that owns one Camp
under a fenced lease, decides and appends domain events with
`expectedSeq` and its fence token. Projections and materialized views are read
models: they catch up through `readAll` by global position under a durable
subscription lease, and their checkpoint is fenced. Snapshots shorten actor
rehydration. `read`, `readAll`, `loadSnapshot` and `loadCheckpoint` are the
read store side and never take locks. The domain event envelope stays in
`hobo.core.v1`; this package owns only store-local records.

Parse, don't validate: configuration, event inputs, append options, lease
keys, fence tokens and positions each cross one parser (`parsePostgresStoreConfig`,
`parseEventInputs`, `parseAppendOptions`, `parseLeaseKey`, `parseSchemaName`)
and become parsed, derived types: the branded `PostgresStoreConfig`,
`SchemaName`, `SubscriptionId`/`PartitionId`, `FenceToken` and
`EventPosition`. Everything past the boundary works on those types and never
re-checks raw input. Database rows are decoded the same way (`rowToEnvelope`
goes through `parseEventEnvelope`).

## Defaults

Mirrors `CD_DEFAULTS` (plan 0024 I.9: "PostgreSQL ≥ 16; statement timeout 5 s;
pool 10"). A unit test holds the parity.

| Setting | Env | Default | Range |
|---|---|---|---|
| `connectionString` | `HOBO_STORE_POSTGRES_URL` | required | libpq URL |
| `schema` | `HOBO_STORE_POSTGRES_SCHEMA` | `hobo_eventstore` | `^[a-z_][a-z0-9_]{0,62}$`, not `public`/`pg_*` |
| `partitionId` | `HOBO_STORE_POSTGRES_PARTITION` | `default` | label in metrics |
| `poolSize` | `HOBO_STORE_POSTGRES_POOL_SIZE` | 10 | 1–100 |
| `statementTimeoutMs` | `HOBO_STORE_POSTGRES_STATEMENT_TIMEOUT_MS` | 5000 | 100–60000 (also `lock_timeout`; idle-in-transaction is 2×) |
| `connectionTimeoutMs` | `HOBO_STORE_POSTGRES_CONNECTION_TIMEOUT_MS` | 5000 | 100–60000 |
| `minServerMajorVersion` | — | 16 | ≥ 16 |
| `leaseTtlMs` | `HOBO_STORE_POSTGRES_LEASE_TTL_MS` | 30000 | 1000–600000 |

The wire form is `PostgresStoreConfigRecord` in
[`data-models/storage_postgres.proto`](data-models/storage_postgres.proto),
constrained by [`storage_postgres.cue`](data-models/storage_postgres.cue).
It is parsed once by `parsePostgresStoreConfig`, which refuses unknown fields.

## Typed failures

Every failure this store raises is an `EventStoreError` with a core `code`.
Its own failures are `StoragePostgresError`, which adds `failure`,
`remediation` and `sqlState`. `remediationFor(error)` covers both.

| `failure` | `code` | Meaning |
|---|---|---|
| `invalid-config` | `INVALID_INPUT` | A configuration field is outside its range. |
| `invalid-input` | `INVALID_INPUT` | A caller exceeded `EVENTSTORE_LIMITS` or passed a malformed value. |
| `server-too-old` | `MIGRATION_FAILURE` | The server is older than PostgreSQL 16. |
| `migration-drift` | `MIGRATION_FAILURE` | An applied migration's checksum differs from the shipped one. |
| `schema-ahead` | `UNSUPPORTED_SCHEMA_VERSION` | The schema was migrated by a newer build. |
| `unavailable` | `PERSISTENCE_UNAVAILABLE` | Connection refused, reset or exhausted. Nothing was committed. |
| `statement-timeout` | `PERSISTENCE_UNAVAILABLE` | A statement exceeded `statement_timeout`/`lock_timeout`. Nothing was committed. |
| `lease-held` | `SUBSCRIPTION_LEASE_CONFLICT` | Another live holder owns the lease. |
| `lease-not-held` | `SUBSCRIPTION_LEASE_CONFLICT` | The lease was released by this holder. |
| `closed` | `PERSISTENCE_UNAVAILABLE` | The store was closed. |

Serialization failures and deadlocks (`40001`, `40P01`) are retried up to three
times as a whole transaction and counted in `transaction.retries`.

## Metrics

Emitted through the injected `StoreTelemetrySink`. Its shape is that of the CD
`TelemetrySink.metrics`. A failing or slow sink never fails or blocks a store
operation.

| Name | Kind | Attributes |
|---|---|---|
| `hobo.storage.postgres.commit.duration` | histogram, ms | `operation`, `outcome` (`ok`/`conflict`/`error`) |
| `hobo.storage.postgres.events.appended` | counter | — |
| `hobo.storage.postgres.conflicts` | counter | `code`, `operation` |
| `hobo.storage.postgres.lease.claims` | counter | `outcome` (`granted`/`held`) |
| `hobo.storage.postgres.checkpoint.commits` | counter | `outcome` (`advanced`/`unchanged`/`stale`/`regression`/`error`) |
| `hobo.storage.postgres.errors` | counter | `failure` |
| `hobo.storage.postgres.transaction.retries` | counter | — |
| `hobo.storage.postgres.migrations.applied` | counter | `to_version` |

Every point also carries `db.system=postgresql`, `hobo.storage.schema` and
`hobo.storage.partition`.

## Layout

- [`src/`](src/README.md): the store, migrations runner, leases, effects and parsing.
- [`src/migrations/`](src/migrations/README.md): numbered, immutable SQL migrations.
- [`data-models/`](data-models/README.md): protobuf records and CUE constraints (codegen into `src/_generated`).
- [`contracts/`](contracts/provider/README.md): the PACT between the CD reconciler (consumer) and this store (provider).
- [`test/`](test/README.md): the live lane, conformance, two-process fence and failover tests.

## Tests

`pnpm --filter @hobo/storage-postgres test`. The live lane picks the first
available of `HOBO_TEST_POSTGRES_URL`, a Docker engine (digest-pinned
`postgres:17-alpine`), or local PostgreSQL ≥ 16 binaries (an ephemeral
cluster). With none available, each live suite is skipped and the reason is
in its name. `HOBO_STORAGE_POSTGRES_LANE=off` skips the lane on purpose.

## Runbook

**Provision.** Use PostgreSQL 16+ and a dedicated database role that owns one
schema per store (`HOBO_STORE_POSTGRES_SCHEMA`). Size `max_connections` to
`replicas × poolSize + replicas`: one extra connection per replica for `LISTEN`.

**First start / upgrade.** Every replica migrates on start, under a
transaction-scoped advisory lock keyed by the schema. Exactly one applies;
the others wait and then see the result. A failed migration rolls back
completely. Roll replicas forward; never run an older build against a newer
schema (`schema-ahead`).

**Readiness.** `store.health()` reports `server-version` and `schema-version`
checks. Wire it into the service readiness probe (WP12).

**`unavailable` / `statement-timeout` spikes.**

1. Check `hobo.storage.postgres.errors{failure}`.
2. In `pg_stat_activity`, look for sessions `idle in transaction` or holding
   locks on `<schema>.streams` or `<schema>.partition_head`.
3. Commands were not committed. Callers retry with the same idempotency keys,
   and dedupe makes the retry safe.

**`migration-drift`.** Someone edited an applied migration or the
`schema_migrations` row. Restore the shipped file. Never update the checksum
by hand. A real schema change is a new numbered migration.

**A reconciler replica died holding a Camp.** No action is needed. Its lease
expires after `leaseTtlMs`, another replica claims with a higher fence and
resumes from `loadCheckpoint`. The dead holder's late writes are refused
(`STALE_FENCE`). To hand over sooner, an operator may `resetCheckpoint` (an
audited `reset` entry in `checkpoint_log`). Never edit `subscription_leases`
by hand, because fence tokens must only increase.

**Audit a handover.** Inspect the subscription's checkpoint log:

```sql
SELECT entry, kind, position, fence_token, holder_id, committed_at
FROM <schema>.checkpoint_log
WHERE subscription_id = $1 AND partition_id = $2
ORDER BY entry;
```

`advance` positions strictly increase, and the fence never falls.

**Backups / restore.** Use ordinary `pg_dump`/PITR of the schema. After a
restore to an earlier point, running consumers see `CHECKPOINT_REGRESSION` or
`STALE_FENCE` and must re-claim. That is the intended fail-closed behaviour.
