# @hobo/data-sqlite

The SQLite data engine (ADR-0177): the `@hobo/data-core` SPI over
`node:sqlite`, plus the synchronous dual-run and schema-apply ports
`@hobo/trails` runs its live lanes on.

Until this package existed those two ports lived inside `@hobo/trails`, which
imported `node:sqlite` directly — so the runbook engine was where every
engine's driver would have accumulated. The SQLite code is here now, built on
one store, and Trails imports no engine.

## Use

```ts
import { createSqliteEngine } from "@hobo/data-sqlite";
import { parseDatasetSchema, runSnapshotAndTail, scopeOf } from "@hobo/data-core";

const source = createSqliteEngine({ path: "/var/hobo/pooled.db" });
const target = createSqliteEngine({ path: "/var/hobo/silo-acme.db" });

await runSnapshotAndTail({
	runtime, // migration id, journal, clock, policy
	source,
	target,
	schema: parseDatasetSchema({ name: "orders", keyFields: ["id"], fields: [/* … */] }),
	scope: scopeOf("orders", "acme"), // move one tenant out of a pooled store
	flipAuthority: async () => { /* rotate the binding */ },
});
```

## What a dataset is in SQLite

A dataset is a real table named after it: a `tenant_id TEXT NOT NULL DEFAULT ''`
column, one typed column per field, and a primary key of
`(tenant_id, <key fields>)`. An open schema adds one `hobo_extra` JSON column
for undeclared fields.

An existing table with the dataset's name is **adopted**, not replaced — that
is how a store written before this engine existed comes under it without a copy.

Five metadata tables sit beside the datasets: `hobo_data_datasets` (the schema
each dataset was ensured with), `hobo_data_journal` (the capture outbox),
`hobo_data_watermarks`, `hobo_data_fences`, and `hobo_data_subscriptions`.

A dataset may not be named `hobo_data_*` or `sqlite_*`
(`INVALID_DATASET_SCHEMA`). Adoption is exactly why: a dataset named
`hobo_data_fences` would adopt the fence table, and the records port would
then read every fence token and delete fences. A store that registered such a
name before it was refused does not serve it either.

## What a write is checked for

`records.write` and `apply.apply` parse every record again with
`parseCanonicalRecord` rather than trusting the caller's object, and require
each mutation's `key` to be the canonical key of the record it carries (for a
delete: a key in canonical form). Anything else is `INVALID_RECORD` and nothing
lands. Without this a uuid written in uppercase and the same uuid in lowercase
were two rows that read back under one key, and a mutation whose key named one
record while carrying another landed under the record's key.

## Type mapping

| Canonical | SQLite | Write | Read | Note |
|---|---|---|---|---|
| `bool` | `INTEGER` | exact | widening | any non-zero integer reads as true |
| `int64` | `INTEGER` | exact | exact | read as `bigint`, never through a double |
| `float64` | `REAL` | exact | exact | |
| `string` | `TEXT` | constrained | exact | U+0000 is refused — SQLite's text API would store the value truncated at the first NUL |
| `bytes` | `BLOB` | exact | exact | |
| `decimal`, `timestamp`, `date`, `uuid`, `json`, `encrypted` | `TEXT` | exact | widening | stored in canonical form; exact through this binding, but SQLite itself accepts any text |

`widening` on read means: a value written through HoBo round-trips byte for
byte; a value written natively by something else may not parse. `constrained`
means the value is refused loudly rather than stored altered. Nothing here is
`lossy`. (The conformance kit found the U+0000 case: this binding originally
declared strings exact and stored such a value truncated.)

## What the declaration says, and why

SQLite is embedded and single-owner (ADR-0135: one partition, one writer).
Three consequences are declared rather than hidden:

| Declared | Meaning |
|---|---|
| `captureOrdering: "global"` | one journal, one total order |
| `fenceEnforcement: "entry-point"` | the fence is a durable row checked inside the write transaction. It stops every writer that goes through this binding; it does not stop another process holding its own connection to the file |
| `snapshotConsistency: "fuzzy"` | a scan pages by key on the same connection. The executors take a capture position first and replay from it, which converges regardless |
| `ddlTransactional: true` | a failing statement rolls its whole phase back |

Capture is a **transactional outbox**: a change is journaled in the same
transaction as the write that caused it, so a change is captured if and only if
it landed. A write that bypasses the binding is not captured
(`SQLITE_CAPTURE_OUTBOX_ONLY`).

## How long the journal keeps a change

**A journal row is kept only while some subscription has yet to acknowledge
it.**

`capture.start` positions a new subscription at the journal head, so a
subscription is never entitled to a change made before it started. It follows
that with no subscription nobody is entitled to anything: the write still
advances the position, and its journal row is released in the same transaction
that wrote it. The journal is therefore empty whenever no subscription exists —
a deleted record does not live on in the outbox.

The **floor** is the position at or before which every change has been
released: the least position any subscription has acknowledged, or the head
when there is none. It rises, and the rows at or below it are deleted, on
`capture.acknowledge`, on `capture.stop` (a stopped subscription releases what
only it was holding), on a write when no subscription exists, and when a store
is opened (which is how a file left by an earlier version is brought under the
rule). A subscription that stops acknowledging pins the journal until it is
stopped.

`retire` removes the retired scope's journal rows — every version of every
record, and the keys of its deletes — in the same transaction as the records.
A subscription that had not yet read them never will; `retire` is an erasure,
and it is not replayed downstream as deletes.

Erasure holds in the file, not only in the tables: the store runs with
`PRAGMA secure_delete = ON`, so a deleted row is overwritten rather than left
readable in the page it was freed from. (SQLite's rollback journal is a
separate file the operating system deletes; scrubbing freed disk blocks is the
volume's job.)

## Capture positions and batches

**A subscription name is bound to its scope.** `capture.start` records the
dataset and tenant a name was started for. Starting the same name again for
that scope answers its original position; starting it for another dataset or
tenant is refused with `DataCoreError` `CAPTURE_SUBSCRIPTION_CONFLICT` — it
never answers the other scope's position. A subscription recorded before
tenants were kept is bound to the first scope that names it.

A position is a journal sequence number in decimal. `capture.read`,
`capture.acknowledge` and the store's `pending` refuse anything else with
`@hobo/data-core`'s `CapturePositionError` (`CAPTURE_POSITION_INVALID`) — the
class and code every engine raises for the same refusal:

- text that is not a sequence number (`"garbage"` used to come back as
  position `"NaN"`);
- a position past the head — one this store never minted, or minted before a
  schema restore rolled the file back;
- for a read, a position below the floor. Those changes were released; an
  empty "caught up" batch would tell a tail it had finished when it had read
  nothing.

An apply that names `expectedWatermark` is conditional: the watermark is
compared inside the `BEGIN IMMEDIATE` transaction that writes the batch, and a
batch naming any other watermark is refused with `StaleApplyError`, leaving
neither a record nor the watermark changed.

A batch never splits a write. Every row of one `records.write` or
`apply.apply` is marked with the transaction it belongs to, and when `limit`
falls inside one the rest of it is returned too, so a batch may hold more than
`limit` changes (the SPI allows exactly this). A tenant-scoped read keeps the
tenant's part of a write whole. Rows journaled before writes were marked read
as one transaction each.

## The schema port

The `schema` port snapshots by copying the store file, so a `:memory:` store
does not declare it (`SQLITE_SCHEMA_SNAPSHOT_NEEDS_FILE`).

- **Snapshots are never overwritten.** A ref is `<store>.snapshot-<uuid>`, and
  the copy is exclusive. (Refs used to be numbered per port instance from 1,
  so re-running a crashed migration copied the half-migrated store over the
  pre-migration snapshot.) The port never deletes a snapshot; removing one
  that is no longer a rollback target is the caller's decision.
- **Every statement of a phase entry runs.** An entry may hold several
  statements separated by `;` and all of them execute, in the phase's one
  transaction. `changes` is the number of rows the phase inserted, updated or
  deleted; DDL counts as none.
- **A verify query is one statement.** SQL after the first statement would
  not have run, so it is refused with `SCHEMA_QUERY_NOT_SINGLE` rather than
  reported as no violations. A trailing `;`, whitespace and comments are fine.

## Fence tokens

A fence token is a credential: presenting it is what lets a writer through the
fence. It is minted with `randomUUID()` — never derived from the scope, the
journal head or the clock, which repeat when a fence is released and raised
again — and it is returned by `raise` and nowhere else. No error or message
carries it; `FencedTenantError` says which tenant is fenced, not with what.

## The dual-run port

`createSqliteDataDualPort({ sourcePath, targetPath, tenant? })` is the
synchronous port the Trails runner and the pooled → siloed tenant move drive.
It is a dual **run**, not a dual write: business writes land on the source and
its journal in one transaction, `replicate()` tails the journal onto the target
under a watermark, and exactly one side is ever the write authority.

`evidence()` returns counts and digests over both stores. Prefer it to
`snapshot()`: a row view makes the oracle itself a custody point for the data
it is checking, and it is what lets the Trails oracle judge a live store
without a row leaving it. `snapshot()` remains for the fixture-shaped oracle.

`reapSource(tenant)` is destructive and refused unless the tenant is fenced,
nothing is un-replicated, and both sides digest equal — on every port, with or
without a `tenant`. An empty journal says nothing about rows that predate it;
only the digests show that the target holds what is about to be deleted. A
reap also removes the tenant's changes from the source journal.

The port pins the source journal from the moment it first opens the store and
keeps its own cursor (the target's watermark), so it holds every change made
after that for as long as the pin exists. Changes the journal released before
the pin — writes made through the engine binding while no subscription
existed — are not tailed, exactly like rows written outside the port:
`lag()` does not count them and `backfill()` covers them.

## Parse, don't validate

Untrusted input becomes a derived domain type before anything touches SQL.

| Raw input | Parser | Derived type | Impossible afterwards |
|---|---|---|---|
| a dataset schema | `parseDatasetSchema` (data-core) | `DatasetSchema` | a table or column name that needs escaping |
| a record | `parseCanonicalRecord` (data-core) | `CanonicalRecord` | a value SQLite would store in a different form than it reads |
| a row read back | the same parser | `CanonicalRecord` | a natively-written value silently accepted in non-canonical form |
| a mutation to write or apply | `parseCanonicalRecord` + the canonical key | `RecordMutation` | a record filed under a key that is not its own |
| a capture position | the store's position parser | a journal sequence at or below the head | a read that skips changes, or reports `NaN` as where it got to |
| a dual-port table name | `quoteIdentifier` | a quoted identifier | a statement separator reaching SQL |

Every value is bound as a parameter. The only strings interpolated into SQL are
identifiers that have passed `quoteIdentifier`.

## Event architecture

This package holds a store, not a control plane. Its part in the
event-sourced design:

- **Commands.** The migration **commands** — run, resume, hold, roll back —
  are handled by the `@hobo/data-core` executors, which drive this binding.
- **Events.** Those executors emit the `migration.*` **events**. The journal
  here is not an event log: its rows are transport records the capture port
  hands to an apply port.
- **Actor.** One store has one writer. The migration aggregate — the single-
  writer **actor** — is the only thing that raises its fence or retires it.
- **Event store.** Migration facts are appended to the durable **event
  store**, never to this database. SQLite as the default event store is
  `@hobo/storage-sqlite`, a different package with a different job.
- **Projections / materialized views.** As a `rebuild-and-swap` target, a
  SQLite dataset is a **materialized view**: a **projection** of the log,
  rebuilt by replay.
- **Snapshots / read store.** The schema port's file copy is the pre-migration
  **snapshot** a failed phase restores from. A projected dataset is the
  application's **read store**, derived and rebuildable.

## Tests

```bash
pnpm --filter @hobo/data-sqlite run build
pnpm --filter @hobo/data-sqlite run test
```

Every test opens real SQLite files — nothing is simulated.
`test/conformance.test.ts` runs the whole `@hobo/data-core` kit three ways:
SQLite to SQLite, SQLite to the reference engine, and the reference engine to
SQLite. `test/data-dual-port.test.ts` replays the Pact contract in
`contracts/pacts/` against two real stores. `test/engine.test.ts` holds the
binding's own guarantees — reserved names, write checks, positions, batches,
journal retention (including a search of the store file's bytes for an erased
value) and fence tokens — and `test/schema-port.test.ts` the schema port's.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
and CUE invariants in `data-models/`, the Pact contract, and the conformance
kit.
