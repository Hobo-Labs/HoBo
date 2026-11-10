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

The `schema` port snapshots by copying the store file, so a `:memory:` store
does not declare it (`SQLITE_SCHEMA_SNAPSHOT_NEEDS_FILE`).

The journal is pruned when a subscription acknowledges: rows no remaining
subscription needs are deleted. With no subscription at all, nothing is pruned.

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
nothing is un-replicated, and both sides digest equal.

## Parse, don't validate

Untrusted input becomes a derived domain type before anything touches SQL.

| Raw input | Parser | Derived type | Impossible afterwards |
|---|---|---|---|
| a dataset schema | `parseDatasetSchema` (data-core) | `DatasetSchema` | a table or column name that needs escaping |
| a record | `parseCanonicalRecord` (data-core) | `CanonicalRecord` | a value SQLite would store in a different form than it reads |
| a row read back | the same parser | `CanonicalRecord` | a natively-written value silently accepted in non-canonical form |
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
`contracts/pacts/` against two real stores.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
and CUE invariants in `data-models/`, the Pact contract, and the conformance
kit.
