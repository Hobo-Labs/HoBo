# @hobo/data-postgres

The provider-neutral PostgreSQL surface: how an app **asks** for a Postgres
database, what a Postgres product **advertises**, how that advertisement is
**proven**, how data **leaves** — and the **engine binding** that lets the
engine-neutral data contract (`@hobo/data-core`, ADR-0177) run against a real
server.

No provider name appears anywhere in this package, and nothing in `src/` imports
a provider or a database driver. That is enforced by a test, not by convention —
`test/neutrality.test.ts` scans the built API surface and the source tree for
provider identifiers and driver imports.

## The five things this package owns

| Concern | Entry point |
|---|---|
| Authoring an ask | `postgres.database({ version, extensions, migration })` |
| The advertised vocabulary | `POSTGRES_GUARANTEES`, `POSTGRES_FEATURES`, `postgresCapability(key)` |
| Proving the advertisement | `postgresConformanceSuite`, `planPostgresConformance`, `runPostgresConformance` |
| Getting the data out | `POSTGRES_MIGRATION_PROFILES`, `buildPgDumpArgv`, `buildPgRestoreArgv`, `buildLogicalCopyPlan` |
| Running the engine contract | `createPostgresEngine`, `createPgExecutor`, `postgresEngineDeclaration` — see [Engine binding](#engine-binding) |

## Authoring

```ts
import { postgres } from "@hobo/data-postgres";

const requirement = postgres.database({
  version: ">=16",
  extensions: ["vector"],
  migration: { export: true, import: true, tools: ["prisma-migrate"] },
});
```

The result is a real `CapabilityRequirement` from `@hobo/capability-profiles`,
parsed on the way out, so an invalid ask throws at authoring time rather than at
placement time.

Three decisions in that helper are worth knowing about:

- **A version range becomes an integer gate.** `">=16"` is kept as the
  human-readable `serverVersion` ranking fact *and* lowered to a
  `serverVersionMajor >= 16` required feature, because a product advertising
  `"17"` must match `">=16"` and string comparison does not do that. The lowering
  is `parsePostgresVersionRange`, exported for anyone who needs the same mapping.
- **Guarantees are required, not preferred.** All seven
  (`POSTGRES_REQUIRED_GUARANTEE_KEYS`) are emitted as required gates. An unset
  key on a candidate fails the gate — absent beats optimistic, because a product
  that has not proven `transactionRollback` should lose a requirement that needs
  it, not win by silence.
- **Placement words are rejected.** Passing `region`, `provider`, `plan`, `tier`
  or similar throws. Those name *where* a thing runs; this helper names *what* is
  needed. Keeping the two apart is the whole reason a neutral package exists.

## The capability vocabulary

Guarantees (all boolean, all required by a `postgres.database()` ask):

`postgresWireProtocol`, `tls`, `transactions`, `transactionRollback`,
`constraints`, `connectionUriBinding`, `ddl`.

Features (ranked and gated, frequently absent):

`serverVersion`, `serverVersionMajor`, `isolationLevels`, `preparedStatements`,
`jsonDocuments`, `jsonb`, `migrationToolCompatibility`, `maxConnections`,
`pooling`, `connectivityTransports`, `extensions`, `credentialRotation`,
`logicalReplication`, `exportSupported`, `importSupported`, `maxStorageBytes`.

Eleven of these keys are already declared by `data.postgres/v1` or its parent
`data.relational/v1` in `@hobo/capability-profiles`. They are re-declared here
verbatim so there is one authoring vocabulary, and
`test/profile-matching.test.ts` asserts the two have not drifted apart.

Why some of the additions exist:

- **`migrationToolCompatibility` is not implied by the wire protocol.** An
  HTTP-only serverless endpoint speaks Postgres and still cannot run `pg_dump`.
- **`connectivityTransports` is not implied either.** A Workers or WASM caller
  has no raw TCP. Reachability is a separate, checkable fact from protocol.
- **`credentialRotation: "none"` is a legitimate value.** After a claim,
  rotation is what actually removes the creating party's authority, so a product
  that cannot rotate should say so and rank accordingly.

## Conformance

`postgresConformanceSuite` is 23 declarative cases. Each names the capability it
proves, the precondition under which it applies, a check, and its dependencies.
Cases are **pure data** — no connections, no clocks, no runtime string
assembly — so a suite can be printed, diffed, and hashed into the conformance
reference a product records (`postgresConformanceRef(productId, checkedAt)`).

```ts
const report = await runPostgresConformance({
  advertised: candidate.structuredCapabilities,
  executors: { sql: mySqlExecutor, binding: myBindingExecutor },
  nowMs: clock(),
});
```

The fold is pessimistic on purpose:

| Situation | Case status | Report outcome |
|---|---|---|
| Executor ran, check passed | `pass` | `pass` only if every applicable case passed |
| Executor ran, check failed | `fail` | `fail` |
| A dependency failed | `blocked` | `fail` |
| No executor for that kind | `not-run` | `unknown` |
| A dependency was not run | `not-run` | `unknown` |
| The product never advertised it | skipped | does not affect the outcome |

`unknown` and `fail` are both non-selectable, so the only way to be picked is to
have actually run the checks. Note the distinction between `blocked` and
`not-run`: collapsing them would let a missing executor masquerade as a product
defect, and a CI lane without a live database would start reporting failures
that are really absences.

Skipping is not forgiveness. A product that never claims `extensions` is not
asked about pgvector; its `extensions` gate then fails on absence at selection,
which is the right place for that decision.

## Migration profiles

Two profiles, both exported as constants and both usable as
`ProfileImplementation.migrationProfiles` entries:

- `migration.postgres.pg-dump/v1` — logical export/restore.
- `migration.postgres.logical-copy/v1` — publication/subscription copy, for
  moves that cannot take downtime.

Only `logical-copy` is declared in the engine binding's `nativeProfiles`, and
so offered by the pattern selector as a `native` realization: the binding's
`nativeTransfer` port runs it (see [Native transfer](#native-transfer-logical-copy)).
`pg-dump` is a migration profile with the argv builders below; running it takes
a process runner this package does not have, so nothing declares it as a native
realization and no decision can select one that could not be executed.

### Commands are argv arrays, and credentials are not in them

`buildPgDumpArgv`, `buildPgRestoreArgv`, and `buildPsqlArgv` return
`readonly string[]`. There is no code path in this package that produces a shell
string, because there is no code path that could then be handed to `sh -c`.

```ts
const argv = buildPgDumpArgv({
  target: { host: "db.example.test", port: 5432, database: "postgres", username: "app_role", sslMode: "require" },
  filePath: "/var/hobo/exports/db.pgc",
  format: "custom",
});
// ["pg_dump", "--host=db.example.test", …, "--no-password", "--file=/var/hobo/exports/db.pgc"]

const env = buildLibpqEnvironment({ target, credential: { channel: "environment" } });
```

`--no-password` is always present, so libpq fails fast instead of blocking on a
terminal prompt inside a non-interactive runner. The password travels in
`PGPASSWORD` (or `PGPASSFILE`, via `credential.channel`), never as an argv
element and never inside a DSN on the command line — argv is world-readable in
`/proc` on Linux, which is the entire reason for the split.

Every interpolated field goes through a parser first (`parsePostgresHost`,
`parsePostgresIdentifier`, `parsePostgresPort`, `parseArtifactPath`,
`parsePostgresTarget`). They reject `;`, backticks, `$(`, `|`, `&`, newlines,
NUL, leading `-`, and `..` traversal. `assertArgvSafe` re-scans the finished
array as a backstop, so a future edit that forgets a parser still cannot ship an
injectable command.

Rejection is deliberate rather than escaping. A database genuinely named
`weird"; DROP` would be quoted correctly by a careful escaper and still be a
value nobody should be able to introduce through a config file — refusing is the
smaller blast radius.

`buildLogicalCopyPlan` returns the publication and subscription **steps** with
the subscription's DSN deliberately left unassembled: the caller composes it
inside a resolved-secret scope so the connection string never becomes a value
this package could accidentally log.

## Engine binding

`createPostgresEngine` implements every port of the `@hobo/data-core` engine SPI
(ADR-0177) against a real PostgreSQL server: datasets are typed tables, the
write fence is a trigger the store itself enforces, change capture is logical
decoding, and the digest is the canonical one. It passes the engine conformance
kit as engine and peer, and cross-engine against the reference engine in both
directions (see [the live lane](#running-the-live-lane)).

```ts
import pg from "pg"; // your dependency, not this package's
import { createPgExecutor, createPostgresEngine } from "@hobo/data-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const engine = createPostgresEngine({
  executor: createPgExecutor(pool),
  namespace: "app",
});
await engine.datasets.ensureDataset(schema);
```

### The executor port

The binding never imports a driver. It takes a `PostgresExecutor`:

```ts
interface PostgresExecutor {
  query(sql: string, parameters?: readonly (string | null)[]): Promise<{ rows; rowCount }>;
  transaction<T>(body: (tx: PostgresExecutor) => Promise<T>): Promise<T>;
}
```

- **Everything crossing it is text or NULL.** Every parameter is cast in the
  statement (`$3::bigint`), and every selected column is cast to text, so no
  driver type parser is ever involved. A driver that hands back a parsed value
  (a number, a `Date`) is a contract violation and `createPgExecutor` refuses it
  with `ENGINE_EXECUTOR_CONTRACT` instead of coercing.
- **A failure carries a SQLSTATE and nothing else is read from it.** The
  server's message text can quote a value, so it is never copied into an error
  this package raises.
- **`transaction` is one session.** Commit when the body resolves, roll back
  when it rejects.

`createPgExecutor(pool)` adapts anything with the two members of a node-postgres
`Pool` it needs (`query`, `connect`). The type is structural, so the driver stays
the caller's dependency, and the caller ends the pool. The boundary is pinned by
`contracts/pacts/postgres-engine-executor.pact.json`, which a test replays
against the real binding.

| Option | Default | Meaning |
|---|---|---|
| `executor` | — | How the server is reached. |
| `namespace` | `public` | Server-side schema holding the dataset tables and the binding's metadata. |
| `capture` | `true` | `false` omits the capture port for a product without logical decoding; the declaration then drops the port and the `logical-copy` fast path, and capture-dependent patterns become ineligible at selection instead of failing at run time. |
| `schemaTables` | `[]` | Tables the schema port snapshots and restores. |
| `pageSize` | `1000` | Rows per keyset page when digesting. |
| `ephemeral` | `false` | `true` makes `close()` drop the namespace, its subscriptions, native transfers and replication slots, and its schema snapshots. For tests and previews; refused for `public`. |
| `nativeSourceConnection` | none | A function resolving the libpq connection string the *target server* reaches the source with, for a native `logical-copy`. A secret: resolved only when a subscription is created, sent as one bind parameter, kept nowhere else. Only the target of a native transfer needs it. |
| `nativePollIntervalMs` | `50` | How long a native progress question waits before answering "not yet". |

By default `close()` drops nothing: a dataset outlives the process, and so does a
capture subscription — it is a durable reader and holds its replication slot
until `capture.stop(subscription)`. A slot nobody stops pins the write-ahead
log, so stop what you start (the copy executors do).

### What a dataset is

`ensureDataset(schema)` creates one table named after the dataset in the
namespace: `tenant_id text NOT NULL DEFAULT ''`, one typed column per field, and
`PRIMARY KEY (tenant_id, <key fields>)`. Tenant and string key columns use the
`"C"` collation, so key order is byte order and cannot shift under an
operating-system locale upgrade. An open schema gets a `hobo_extra jsonb` column
for its undeclared fields. The schema is recorded in `hobo_data_datasets`, so
`describeDataset` returns it, a second binding finds it, and a differing schema —
or a pre-existing table that is not a dataset — is refused with
`INVALID_DATASET_SCHEMA`.

### Type mapping annex

| Canonical | Native | Write | Read | The limit, stated |
|---|---|---|---|---|
| `bool` | `boolean` | exact | exact | |
| `int64` | `bigint` | exact | exact | |
| `float64` | `double precision` | exact | widening | A natively written `NaN` or infinity has no canonical form and is refused on read. |
| `decimal` | `numeric` | constrained | widening | Unconstrained `numeric` holds 131072 digits before and 16383 after the point; the server refuses more. Native `NaN`/infinity is refused on read. |
| `string` | `text` | constrained | exact | `text` cannot hold U+0000 or an unpaired surrogate. Either is refused at write, never stored altered. |
| `bytes` | `bytea` | exact | exact | |
| `timestamp` | `timestamptz` | constrained | widening | Microsecond-exact for years 0001–9999. The server has no year 0000 and refuses it at write — an instant whose UTC form falls in year 0000 included. A native BC instant, one past year 9999, or an infinity is refused on read. |
| `date` | `date` | constrained | widening | Same range rule as `timestamp`. |
| `uuid` | `uuid` | exact | exact | |
| `json` | `jsonb` | constrained | widening | `jsonb` refuses U+0000 inside a string. It keeps numbers at arbitrary precision, so a natively written number float64 cannot hold exactly reads as the nearest float64, and one beyond float64's range (`1e400`) is refused on read. |
| `encrypted` | `jsonb` | constrained | widening | An opaque `{ alg, keyRef, ciphertext }` envelope; the ciphertext is never interpreted. `jsonb` refuses U+0000 inside `alg` or `keyRef`, and a natively written value of another form is refused on read. |

No edge is `lossy`. "Constrained" means a value outside the constraint is
refused loudly, with `INVALID_RECORD`, and the whole write rolls back.
"Widening" means the native type can hold values the canonical model cannot; a
record written through HoBo always round-trips, and a natively written value
with no canonical form fails the read (and the digest) rather than being
altered.

Reads are byte-identical to writes because nothing is left to a session setting:
a float is read as its eight IEEE-754 bytes, bytes as hex, and a timestamp as
UTC ISO text with six fractional digits — it never passes through a JavaScript
`Date`, which would round to milliseconds. Every row then goes through
`parseCanonicalRecord`, so `numeric` trailing zeros, `jsonb` key order and base64
padding are all normalised the same way the writer's were.

### The fence is enforced by the store

The declaration says `fenceEnforcement: "store"`, and that is literal. Each
dataset table carries a `BEFORE INSERT OR UPDATE OR DELETE` row trigger. While a
fence row exists for the dataset with tenant `''` or the row's tenant, the
trigger raises SQLSTATE `HB001` — which the binding maps to `FencedWriteError` —
unless the session setting `hobo.fence_token` equals that fence's token. The
binding presents a request's token with `set_config(…, true)`, so it lasts for
that one transaction and never leaks to the session's next user.

A client holding its own connection is refused too — that is the difference
from an entry-point fence. So is a session in replica mode: the trigger is
`ENABLE ALWAYS`, which is how a native logical-replication apply worker writes.

The trigger function is `SECURITY DEFINER` with `search_path` pinned to
`pg_catalog, pg_temp`, and the binding's metadata tables are revoked from
`PUBLIC`. So a role that only writes a dataset needs — and is given — no
privilege on them: it cannot read a token out of `hobo_data_fences`, cannot
lock the registry row `raise` waits on, and cannot shadow an operator the
trigger compares with through its own search path. What can still get past the
fence is the table's owner or a superuser (who can disable the trigger, read a
token, or delete the fence row), and any role the owner later grants the fence
table to. The token is kept there in the clear, because raising a raised fence
has to be able to answer it; a namespace bootstrapped by an older binding is
brought up to this by the next binding that opens it.

Raising a fence is a real barrier, not a flag. The trigger takes a share lock on
the dataset's registry row before it looks for a fence, and `raise` updates that
row: it therefore waits for every writer already past the check to finish, and
every later writer waits for the fence to commit and then sees it. `retire` takes
the same row exclusively, so no write — not even the token holder's — can land
between its digest and its delete.

`TRUNCATE` on a dataset table is refused outright (`HB002`): it fires no row
trigger and names no keys, so it could be neither fenced per tenant nor captured.

### Change capture

Capture is logical decoding with the `pgoutput` plugin, driven through the
server's SQL decoding functions, so it needs no replication-protocol
connection — any session that can run a query can tail the log.

- **`start`** creates a publication for the dataset's table, then a logical
  replication slot, and records the slot's consistent point as the start
  position in `hobo_data_subscriptions`. Starting an existing subscription —
  from this binding or another — returns that original position. A change
  committed before `start` is never returned.
- **`read`** peeks the slot without consuming it and decodes the binary
  messages with the pure decoder in `src/engine/pgoutput.ts`. It returns changes
  strictly after `after`, in **commit order** (the order transactions committed,
  not the order they began). A position is where a transaction's commit record
  ends, so every change of one transaction shares a position.
- **Whole transactions only.** The limit is honoured at transaction
  boundaries: a batch never ends inside a transaction, and one transaction
  larger than the limit is returned whole. `caughtUp` is exact — it is true only
  when the decoding call reached the end of the log and nothing was held back.
- **Tenant scope.** A tenant-scoped subscription returns only that tenant's
  changes, while its position still advances past everyone else's.
- **`acknowledge`** advances the slot, releasing the log before that position.
  Reading from a position that has since been released is refused
  (`CAPTURE_POSITION_INVALID`) rather than answered with a silent gap, and a slot
  that has vanished is reported (`CAPTURE_SUBSCRIPTION_LOST`), never papered
  over with an empty batch.
- **`stop`** drops the slot and the publication.

Decoded values arrive as text through the type output functions, which obey
session settings, so the decoding call pins `TimeZone`, `DateStyle`,
`bytea_output` and `extra_float_digits` for its own transaction and the text is
then normalised exactly as a read is.

Deletes carry tenant and key from the table's default replica identity (the
primary key). A native update that changes a key arrives as a delete of the old
key followed by an upsert of the new one.

One resume point needs care: when a read is caught up, the binding only offers
the head of the log as the next position if everything inserted is also
flushed. A bare flush location can fall inside a commit record, and
acknowledging it would make the server skip that transaction.

### Verify, snapshot, retire, apply

`verify.digest` streams the scope by keyset pagination inside one
repeatable-read transaction, converts each row to its canonical record, and feeds
`DatasetDigestBuilder` — so the result equals the canonical digest of the same
records and compares directly against any other engine's. No row leaves the
port. `snapshot` is the same keyset scan without the single transaction, which is
why the declaration says `fuzzy`: the copy executors take a capture position
first and replay from it, which converges either way. `apply` writes its changes
and its watermark in one transaction, so redelivery is harmless and an empty
batch still advances the watermark. `retire` re-digests under the fence and
refuses on any difference before it deletes.

### Schema apply

`applyPhase` runs its statements in one transaction with the namespace first on
the search path (`public` stays behind it, for extension types and functions);
DDL is transactional here, so a failing statement leaves nothing of the phase
behind. `verify` returns each violation row as one JSON document.

`snapshot()` copies each table in `schemaTables` into a separate server-side
schema (`CREATE TABLE … (LIKE … INCLUDING ALL)` plus the rows), and `restore()`
drops the live tables and recreates them from the copy — structure, defaults,
check and key constraints, indexes and data all return, and a table that did not
exist at the snapshot is dropped. A snapshot is kept until
`dropSchemaSnapshot(ref)`.

### Native transfer: logical-copy

`migration.postgres.logical-copy/v1` is the binding's one native realization:
PostgreSQL's built-in logical replication carries the records, and the copy
executors in `@hobo/data-core` keep every phase, the digests, the fence, the
cutover and the journal (`runSnapshotAndTail({ realization: "native", profile:
LOGICAL_COPY_PROFILE, … })`).

```ts
const source = createPostgresEngine({ executor: sourceExecutor, namespace: "app" });
const target = createPostgresEngine({
	executor: targetExecutor,
	namespace: "app", // the same name, in another database
	nativeSourceConnection: () => secrets.resolve("source-replication-dsn"),
});
```

- **Source:** a publication for the dataset's table and a logical replication
  slot — the two objects a capture subscription is made of, recorded in the
  same registry under a `native:` key. The slot is created by its own
  statement and the subscription is told `create_slot = false`: a subscription
  that creates its own slot hangs when both databases share a cluster.
- **Target:** a server-side subscription with `copy_data = true`. The target
  server connects to the source, copies the table, then applies every change.
- **Progress:** the target says when every table of the subscription is ready
  (`seeded`); the source writes a transactional logical message as a mark and
  says when its slot's confirmed position has passed it (`reached`).
- **The connection string is a secret.** It is given as a function, resolved
  only when a subscription is created, and sent as one bind parameter into a
  transaction-local setting; no statement text contains it and the statement
  answers a boolean. `CREATE SUBSCRIPTION` runs inside a block whose handler
  re-raises a failure with its SQLSTATE alone, because the server would
  otherwise report the whole statement as error context. Whatever the driver
  throws is discarded but for that SQLSTATE. It is never in a ticket, an
  error, or a fact.
- **Cleanup.** The executor drops the subscription (which drops the slot, and
  any slot an unfinished copy made), then the publication and the registry
  row: after the cutover is journaled, before the source is retired, and on a
  rollback. An ephemeral binding's `close()` drops every transfer its
  namespace holds. When the source cannot be reached the subscription is
  detached and dropped locally and the source's half is left to its own
  `stop`; a slot from an unfinished copy can then remain on the source.

### Honest limits

These are the engine's declared impedance codes (`POSTGRES_IMPEDANCE_CODES`).
Each is a real limit, stated so nobody over-claims fidelity.

| Code | What it means |
|---|---|
| `POSTGRES_RESERVED_COLUMN_NAMES` | A field may not be named `tenant_id` or `hobo_extra`. |
| `POSTGRES_TEXT_REFUSES_NUL_AND_LONE_SURROGATES` | See the `string` edge above. |
| `POSTGRES_JSONB_NUMBERS_READ_AS_FLOAT64` | See the `json` edge above. |
| `POSTGRES_NATIVE_VALUES_BEYOND_CANONICAL_RANGE` | Native `NaN`, infinities, BC and five-digit years fail a read instead of being altered. One such row therefore also fails the digest and stalls capture until it is fixed. |
| `POSTGRES_SNAPSHOT_IS_FUZZY` | The snapshot scan is keyset pagination, not one MVCC snapshot. |
| `POSTGRES_FENCE_TRIGGER_OWNER_CAN_DISABLE` | The fence is a trigger that runs with its owner's rights over metadata tables no other role is granted. The table's owner or a superuser can still disable it, read a token from `hobo_data_fences` (kept in the clear), or delete the fence row; so can a role the owner grants that table to. A writer that keeps a transaction open after writing keeps `raise` waiting until it ends. |
| `POSTGRES_TRUNCATE_REFUSED_ON_DATASETS` | Delete records instead. |
| `POSTGRES_CAPTURE_NEEDS_LOGICAL_DECODING` | `wal_level = logical`, the `REPLICATION` privilege, and one replication slot per subscription. Creating a slot waits for transactions already open to finish. |
| `POSTGRES_CAPTURE_SLOT_PINS_LOG` | An unacknowledged or abandoned subscription retains write-ahead log until it is stopped. |
| `POSTGRES_CAPTURE_WHOLE_TRANSACTIONS` | A transaction larger than the read limit is returned whole, and each read re-decodes from the last acknowledged position. |
| `POSTGRES_CAPTURE_UNCHANGED_TOAST_REREAD` | A native `UPDATE` that leaves a large out-of-line value untouched does not log that value. The binding completes the row by re-reading it, so that one change may carry a newer row than the log position it sits at; later changes still arrive in order and the stream converges. With `REPLICA IDENTITY FULL` the value is taken from the old image instead and no re-read happens. Writes through the binding always log every column. |
| `POSTGRES_CAPTURE_SLOT_NOT_FAILOVER_SAFE` | A slot is not carried to a standby; after a failover the subscription is lost and says so. |
| `POSTGRES_SCHEMA_SNAPSHOT_IS_A_COPY` | A snapshot is a table copy in the same database, not a provider point-in-time restore: it costs space and time in proportion to the data. |
| `POSTGRES_SCHEMA_SNAPSHOT_REFUSES_DEPENDENT_OBJECTS` | `snapshot()` refuses, by name, a table with foreign keys (either direction), triggers, identity or sequence-backed columns, row security, grants, partitions or inheritance, a table owned by another role, a table in a publication — none of which survive drop-and-recreate — and a dataset table, which carries the fence. It refuses rather than restoring something quietly different. |
| `POSTGRES_SCHEMA_RESTORE_RECREATES_TABLE` | A restored table is a new relation: index and key-constraint names are regenerated and its object id changes. A view that came to depend on the table fails the restore loudly. |
| `POSTGRES_RETIRE_IS_LOGGED_AS_DELETES` | `retire` deletes rows and the write-ahead log records deletes, so a subscription still reading the dataset captures them. The copy executors drop a migration's own forward channel before retiring, so the retirement never follows the data to the new authority; a reader of someone else's sees the scope leave the store. |
| `POSTGRES_NATIVE_COPY_WHOLE_DATASET_SAME_NAME` | `logical-copy` moves a whole dataset table into an empty table of the same schema-qualified name in another database. One tenant of a pooled table, a renamed namespace or dataset, a target that already holds rows, and the source database as its own target are refused by name. |
| `POSTGRES_NATIVE_COPY_NO_REVERSE_TAIL` | The transfer is dropped at cutover and nothing tails back, so a rollback from soak is to-snapshot. |
| `POSTGRES_NATIVE_COPY_TARGET_HOLDS_SOURCE_CONNECTION` | The target server keeps the source connection string in `pg_subscription` until cutover drops the subscription. Its superusers can read it, and a target that logs statement parameters records it. |
| `POSTGRES_NATIVE_COPY_NEEDS_REPLICATION_CAPACITY` | `wal_level = logical`, a free replication slot and sender on the source (one more while the initial copy runs), a free logical-replication worker on the target, and a target role that may create subscriptions (a superuser, or `pg_create_subscription` from PostgreSQL 16). |

### Running the live lane

The decoder, the DDL and statement text, the value conversions, the declaration,
the driver adapter, the capture read loop (over a scripted server answering with
recorded bytes) and the executor pact are tested on every run, with no database.
`test/fixtures/pgoutput-v1.recorded.json` holds real `pgoutput` bytes recorded
from PostgreSQL 16.

The live lane is gated on `HOBO_TEST_POSTGRES_URL` and skipped without it:

```bash
HOBO_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/postgres \
  pnpm --filter @hobo/data-postgres run test
```

It needs a server with `wal_level = logical`, a few free replication slots, and
a role allowed to create schemas, publications and replication slots. The
binding was developed and verified against PostgreSQL 16; its statements use
nothing newer than PostgreSQL 14 (`CREATE OR REPLACE TRIGGER`), but no earlier
version than 16 has been run. It runs the engine conformance kit three ways (PostgreSQL as
engine and peer; PostgreSQL → reference engine; reference engine → PostgreSQL),
a concurrency lane that replays decoded changes from eight competing writers
onto the reference engine and compares digests, and direct proofs of the fence,
the type edges, and schema restore. Every binding gets its own namespace and
drops it on close; the lane fails if a replication slot, publication or
subscription of its own outlives it. The check is attributable: slot names are
cluster-wide and other suites share a server, so each test file counts only the
objects carrying the digests of the namespaces it used itself
(`captureObjectPrefixes`, `nativeSubscriptionPrefix`). The native lanes create
one extra database per test file and drop it. Re-record the fixture with
`HOBO_RECORD_PGOUTPUT=1`.

## Error codes

`PostgresDataError.code` is one of `INVALID_POSTGRES_REQUIREMENT`,
`UNSAFE_COMMAND_ARGUMENT`, `MIGRATION_FAILED`, `CONFORMANCE_SUITE_INVALID`,
`CONFORMANCE_EXECUTOR_MISSING`, and — from the engine binding —
`ENGINE_OPTIONS_INVALID`, `ENGINE_EXECUTOR_CONTRACT`, `CAPTURE_POSITION_INVALID`,
`CAPTURE_SUBSCRIPTION_LOST`, `CAPTURE_STREAM_UNDECODABLE`,
`NATIVE_SUBSCRIBE_FAILED`, `NATIVE_STOP_FAILED`. Each carries a structured
`detail` naming the offending field; the two native codes carry a SQLSTATE and
nothing else, because the server's own text can quote the connection string.
A native transfer the binding will not attempt is a `@hobo/data-core`
`NATIVE_TRANSFER_REFUSED` whose `detail.reason` says why, and one whose server
objects are gone is `NATIVE_TRANSFER_LOST`.

The engine binding raises the engine-neutral refusals as `@hobo/data-core`
errors, so every engine reports them the same way: `FencedWriteError`
(`FENCED_WRITE`), `INVALID_RECORD`, `INVALID_DATASET_SCHEMA`,
`FENCE_TOKEN_MISMATCH`, `RETIRE_REFUSED`, and `INVALID_MIGRATION_PLAN` for a
schema snapshot it will not take. A server error that is none of these — a
serialization failure, a lost connection — is rethrown untouched for the caller
to retry.

## Parse, don't validate

Untrusted input crosses one parse boundary and becomes a derived domain type
that the rest of the package accepts as-is:

| Raw input | Parser | Derived type | Impossible afterwards |
|---|---|---|---|
| authoring options | `postgres.database` | a parsed `CapabilityRequirement` | a placement word (`region`, `provider`, `plan`) in a capability ask |
| version range string | `parsePostgresVersionRange` | `serverVersionMajor` gate | `">=16"` losing to `"17"` under string comparison |
| host / port / db / user | `parsePostgresTarget` | `PostgresTarget` | a shell metacharacter, a leading dash, or `..` reaching an argv element |
| artifact path | `parseArtifactPath` | a checked absolute path | traversal out of the export directory |
| a suite | `assertConformanceSuiteWellFormed` | a well-formed `PostgresConformanceSuite` | an unknown capability key or a dependency cycle |
| engine options | `createPostgresEngine` (`parseNamespace`) | a `PostgresEngine` over a checked namespace | a system schema, an unquotable name, or an ephemeral binding that would drop `public` |
| a native row (selected text, or a decoded tuple) | `canonicalFromNative` → `parseCanonicalRecord` | a `CanonicalRecord` | a value that reads back different from what was written; a native `NaN`, infinity or BC date reaching a digest |
| a log position | `parseLsn` | a 64-bit location | another engine's position being compared as text, or `9/0` sorting after `10/0` |
| `pgoutput` bytes | `decodePgOutputTransactions` | whole `PgOutputTransaction`s | a partial transaction, a change for an undescribed relation, or an unknown message being skipped |
| an executor result | `createPgExecutor` | a text-only `PostgresRow` | a driver-parsed number or `Date` slipping past the cast-everything rule |

`buildPgDumpArgv` and its siblings take the parsed target, never the raw fields,
so there is no code path that re-checks an identifier and no code path that
forgets to. `assertArgvSafe` re-scans the finished array only as a backstop for
a future edit that adds a field without a parser.

The protobuf records in `data-models/postgres_capability.proto` are the wire
projection of these parsed types, and `postgres_capability.cue` carries the
invariants that make an advertisement honest — `jsonb` implies `jsonDocuments`,
rollback implies transactions, and a product that cannot export cannot also
claim `pg-dump` compatibility. `data-models/postgres_engine.proto` and
`postgres_engine.cue` do the same for the engine binding: its options, the
executor request and response, and the rows it keeps in its metadata tables —
an ephemeral binding must name a namespace other than `public`, a slot name
must be one a server accepts, and a schema snapshot must cover at least one
table.

## Event architecture

The authoring, vocabulary, conformance and migration-profile surfaces are a pure
core: they hold no state, open no connection, read no clock, and append nothing.
Their outputs are what the durable control plane carries.

- **Commands** — a conformance report is what lets a selection **command** name
  this product at all; a migration plan is the payload of the `@hobo/claims`
  coordinator's `BeginResourceMigration`, `RecordMigrationCheckpoint`,
  `CommitConnectorCutover`, and `RotateCapabilityBinding` commands. Each carries
  the parsed target and the argv array built here, so a command replays against
  one concrete endpoint rather than against a re-interpolated string.
- **Events** — the claim coordinator **actor** (`reduce` in `@hobo/claims`)
  turns those commands into `ResourceMigrationStarted`,
  `ResourceMigrationCheckpointRecorded`, `ResourceMigrationVerified`,
  `LogicalConnectorCutoverCommitted`, and `CapabilityBindingRotated`. The
  `PostgresConformanceReport` record is what a `pass`/`fail`/`unknown` outcome in
  those event bodies means. No credential enters a body: the password is a
  channel (`PGPASSWORD`, `PGPASSFILE`), never a record field.
- **Event store** — the host appends those events to the durable SQLite-backed
  **event store** under per-stream OCC and a fencing token. `pg_dump` and
  `pg_restore` run outside that transaction, keyed by idempotency, so a retried
  migration does not produce a second archive.
- **Projections / materialized views** — the stream folds into the
  **materialized views** selection and the CLI read: current conformance outcome
  per product, the migration profiles a product supports, and the last verified
  export. Because `unknown` and `fail` are both non-selectable, a product only
  becomes selectable by appearing in that view with evidence.
- **Snapshots / read store** — periodic **snapshots** of the resource aggregate
  back the **read store** behind `hobo status`; historical snapshots keep the
  conformance reference a product was chosen under auditable after it is
  re-checked, which is why `postgresConformanceRef` pins the suite, the product,
  and the date a human looked.

The engine binding is the one part that touches a store, and it still appends
nothing to the event log. It is driven by the `@hobo/data-core` migration
executors — the **actor** that turns a migration **command** into `migration.*`
**events** (`migration.Planned`, `migration.Verified`, `migration.CutOver`, …) —
and what those events record is only what its ports return: positions,
watermarks, counts and digests. A record never
enters an event: a change envelope passes from a capture port to an apply port
and is gone. The binding's own durable state is rows in its metadata tables
(dataset registry, fences, watermarks, subscriptions, schema snapshots), which
are operational state of the store it fronts, not an **event store**; the
migration journal that makes a run resumable lives with the executor. Its
`verify` digests are the evidence the migration **projection** (the
**materialized view** of a run's phase) and the **read store** behind status
show, and a schema-port **snapshot** is the restore point `in-place-evolve`
records before it changes anything.

## Tests

```bash
pnpm --filter @hobo/data-postgres run build
pnpm --filter @hobo/data-postgres run test
```

Offline and deterministic by default; no database is started and no clock is
read. The lanes pin, among other things: a SQLite/D1-shaped candidate never
satisfies `data.postgres/v1` while Neon-shaped and Prisma-shaped candidates do;
every argv builder rejects each injection class in every interpolated field; the
conformance fold returns `unknown` rather than `pass` when an executor is
missing; the `pgoutput` decoder reads bytes recorded from a real server; and the
engine binding issues exactly the statements its executor pact names.

The engine binding's live lane — the engine conformance kit against a real
server, and capture under concurrency — runs only when `HOBO_TEST_POSTGRES_URL`
is set. See [Running the live lane](#running-the-live-lane).

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
in `data-models/postgres_capability.proto` and `postgres_engine.proto`, the CUE
invariants in the matching `.cue` files, and the Pact-shaped boundary contracts
in `contracts/pacts/postgres-conformance.pact.json` and
`postgres-engine-executor.pact.json`.
