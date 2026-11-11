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

## The six things this package owns

| Concern | Entry point |
|---|---|
| Authoring an ask | `postgres.database({ version, extensions, migration })` |
| The advertised vocabulary | `POSTGRES_GUARANTEES`, `POSTGRES_FEATURES`, `postgresCapability(key)` |
| Proving the advertisement | `postgresConformanceSuite`, `planPostgresConformance`, `runPostgresConformance` |
| Getting the data out | `POSTGRES_MIGRATION_PROFILES`, `buildPgDumpArgv`, `buildPgRestoreArgv`, `buildLogicalCopyPlan` |
| Running the engine contract | `createPostgresEngine`, `createPgExecutor`, `postgresEngineDeclaration` — see [Engine binding](#engine-binding) |
| Running on several backends at once | [the fleet](#the-fleet): `proposeAssignment`, `readCurrentAssignment`, `replicateSnapshot` |

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
  committed before `start` is never returned. A subscription name is bound to
  the scope it was started for: starting it again for another dataset or
  tenant is refused (`CAPTURE_SUBSCRIPTION_CONFLICT`) rather than answered
  with the other scope's position.
- **A slot is proven before its position is handed to anyone.** A slot
  created while a transaction that created or rewrote a table is still open
  can be poisoned: every read from it then fails with the server's "could not
  map filenumber", for ever. So `start` (and a native `publish`, which makes
  its slot the same way) waits for the transactions that were open at the
  slot's consistent point to end, then runs one decoding probe over it. A slot
  that fails the probe has had nothing read from it, so it is dropped and
  another is created — the one statement the binding ever repeats, and only
  for that one failure. If the open transactions do not end, or several slots
  in a row are poisoned, `start` fails with `CAPTURE_SLOT_UNPROVEN`
  (`detail.reason`: `TRANSACTIONS_STILL_OPEN` or `UNDECODABLE`) and nothing is
  left started; start the subscription again later.
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
batch still advances the watermark. A conditional apply (`expectedWatermark`)
writes the watermark *first*, in a statement that only takes effect from the
position the applier named — an `UPDATE … WHERE log_position = $4`, or an
`INSERT … ON CONFLICT DO NOTHING` when it named none. That statement takes the
row's lock, so a second applier naming the same watermark waits for the first
to commit, matches no row, and is refused with `StaleApplyError` before it has
written a record; the refusal rolls the transaction back. `retire` re-digests
under the fence and refuses on any difference before it deletes.

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
- **Pause and resume.** A held migration moves nothing, so when a native run
  holds the executor calls `pause` on the target: `ALTER SUBSCRIPTION …
  DISABLE`, then a wait until `pg_stat_subscription` shows no worker left
  attached — disabling stops new work, and a worker already running only
  notices when it next looks. If a worker never lets go, `pause` fails with
  `NATIVE_PAUSE_FAILED` rather than reporting a pause that did not happen.
  `resume` is `ALTER SUBSCRIPTION … ENABLE`. Both do nothing for a transfer
  that was never subscribed or was stopped. The source's slot keeps retaining
  the log while paused. PostgreSQL restarts an unfinished initial table copy
  when a subscription is re-enabled, which is why the executor leaves the
  transfer running through a hold that only says the copy has not finished.
- **The connection string is a secret.** It is given as a function, resolved
  only when a subscription is created, and sent as one bind parameter into a
  transaction-local setting; no statement text contains it and the statement
  answers a boolean. `CREATE SUBSCRIPTION` runs inside a block whose handler
  re-raises a failure with its SQLSTATE alone, because the server would
  otherwise report the whole statement as error context. Whatever the driver
  throws is discarded but for that SQLSTATE. It is never in a ticket, an
  error, or a fact.
- **…and is kept out of the target server's log.** A server that logs
  statements (`log_statement`, `log_min_duration_statement`,
  `log_min_duration_sample`) logs their bind parameters with them. The
  transaction that carries the string therefore first sets, for itself only,
  `log_parameter_max_length = 0`, `log_parameter_max_length_on_error = 0`,
  `log_statement = 'none'` and both duration thresholds to `-1`
  (`QUIET_NATIVE_LOGGING`) — each on its own, so one the role may not change
  does not take the others with it — and then *reads the settings back*
  (`NATIVE_LOGGING_STATE`). The string is sent only if the answer is quiet:
  either no statement line would be written, or it would be written without
  parameters, and an error would carry none. All but the on-error length need
  a superuser or, from PostgreSQL 15, `GRANT SET ON PARAMETER`. A role that
  cannot quiet a server that logs is **refused**
  (`NATIVE_TRANSFER_REFUSED`, reason `CONNECTION_WOULD_BE_LOGGED`) before the
  string leaves the process: grant the role `SET` on
  `log_parameter_max_length`, subscribe as a superuser, or turn statement
  logging off for that role or database. A role on a server that logs nothing
  needs no privilege. What this cannot see: an extension that logs parameters
  by its own settings (pgaudit's `pgaudit.log_parameter`).
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
| `POSTGRES_NATIVE_COPY_TARGET_HOLDS_SOURCE_CONNECTION` | The target server keeps the source connection string in `pg_subscription` until cutover drops the subscription. Its superusers can read it. |
| `POSTGRES_NATIVE_COPY_NEEDS_REPLICATION_CAPACITY` | `wal_level = logical`, a free replication slot and sender on the source (one more while the initial copy runs), a free logical-replication worker on the target, and a target role that may create subscriptions (a superuser, or `pg_create_subscription` from PostgreSQL 16). |
| `POSTGRES_NATIVE_COPY_REFUSED_WHERE_CONNECTION_WOULD_BE_LOGGED` | The connection string is a bind parameter, and a server that logs statements logs parameters. The subscribing transaction turns that off for itself first, which takes a superuser or `SET ON PARAMETER`; a role that cannot, on a server that logs, is refused (`CONNECTION_WOULD_BE_LOGGED`) instead of logged. Parameter logging by an extension (pgaudit) is outside what the binding can check. |

### Running the live lane

The decoder, the DDL and statement text, the value conversions, the declaration,
the driver adapter, the capture read loop (over a scripted server answering with
recorded bytes) and the executor pact are tested on every run, with no database.
`test/fixtures/pgoutput-v1.recorded.json` holds real `pgoutput` bytes recorded
from PostgreSQL 16.

The live lane is gated on `HOBO_TEST_POSTGRES_URL` and skipped without it. CI's
`Live data engines` job starts a PostgreSQL 16 for it on pull requests whose diff
reaches these suites, and nightly. To run it yourself:

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

## The fleet

A fleet is several interchangeable PostgreSQL backends behind one application:
one **writer** and any number of **standbys**. The code is under `src/fleet/`.
It opens no connection. A host gives it one `SqlExecutor` per backend (a
`query(sql, parameters)` and a `session(run)` that pins one connection) and an
opaque id for each. Nothing in it knows how many backends there are or what any
of them is called.

Every statement the fleet sends casts its result columns to `text`, so the port
does not depend on how a driver decodes a `bigint` or a `timestamptz`.

### The assignment register: who the writer is

Each backend keeps a small append-only log table (the name comes from
`parseFleetLayout`). An entry names the writer for one **epoch**:

`(epoch, active, sealed, target, reason, loss_window_ms, decided_at, decided_by)`

An epoch is **decided** when a majority of the *configured* backends hold the
same entry for it. The **current assignment** is the highest decided epoch.
Three rules, each enforced on one backend alone, are all the safety there is:

1. A backend holds at most one entry per epoch (a primary key).
2. A backend takes an entry for epoch `e` only when its newest entry is
   `e - 1`. `sqlAssignmentReplica` checks and inserts in one statement.
3. An entry that names a backend as the writer is written to that backend
   first, and to no other backend if it does not take it.

What follows from them:

- **Never two decisions for one epoch.** Two majorities share a backend, and
  that backend holds one entry.
- **The decided epoch never goes backwards.** Logs are append-only.
- **A proposal made on a stale view is never decided.** If a newer epoch is
  already decided, a majority already hold an entry for the proposer's epoch,
  so its entry can land only on the backends that were behind: a minority.
- **A backend knows when it is the writer.** By rule 3 its own log holds every
  decided entry that names it, which is what lets replication refuse to
  overwrite a writer using a check on that one backend.

| Function | What it does |
|---|---|
| `readCurrentAssignment` | Majority read. Returns `current`, `empty`, `undecided` or `no-majority` |
| `proposeAssignment` | Compare-and-set on the current epoch; writes `current + 1` |
| `bootstrapAssignment` | The first epoch. The entry is the same bytes whoever writes it |
| `completeAssignment` | Copies an interrupted proposer's entry (same epoch, same value) onto more backends, and repairs short logs |
| `overrideAssignment` | Operator only: writes above everything visible, without the compare-and-set |

A reader **fails closed**. With answers from fewer than a majority the result is
`no-majority`. When the newest epoch it can see is held by fewer than a
majority the result is `undecided`, and the decided epoch below it is *not*
returned instead, because something newer may already be decided out of sight.
A caller that gets either stops writing.

A proposer does not decide on older information either. If the newest epoch is
undecided it returns `unavailable` and writes nothing; `completeAssignment`
finishes that entry first. Only the outcome `decided` means an entry is the
current assignment. `undecided`, `stale`, `refused` and `unavailable` all mean
"read again".

**Counting backends.** A majority of `n` is `floor(n / 2) + 1`. Three backends
tolerate one being down, five tolerate two. An even count buys nothing: four
tolerate one, like three, and two tolerate none (both must answer). Prefer an
odd count.

**What it does not do.**

- A backend that returns having *lost its log table* breaks the argument above,
  like amnesia in any quorum. Remove it from the configuration or restore its
  log before it rejoins.
- Changing the list of backends changes what a majority is. Do it while every
  backend is healthy and no decision is in flight, one backend at a time.
- A fully split epoch (every backend holds a different entry for it, which
  needs proposers that could each reach a different backend first) cannot be
  completed. Readers stay `undecided` until a person calls
  `overrideAssignment`. In the 400 randomized runs below, which keep taking
  backends down and include overrides fired at random, 26 ended that way: 25
  were fleets of two or four, one a fleet of five, none a fleet of three.

`test/fleet-assignment.test.ts` checks the invariants after every step of 400
seeded interleavings of concurrent proposers, completers and overrides against
an in-memory fleet of two to five backends that go down and come back,
including writes that were applied but whose answer was lost.
`contracts/pacts/postgres-fleet.pact.json` is the boundary contract for one
backend's log and for a majority read; `test/fleet-contract.test.ts` replays it.

### Replication: keeping standbys current

`replicateSnapshot({ source, target, layout, assignment })` replaces a
standby's copied tables with one consistent snapshot of the writer's. It uses
two ordinary connections: no replication role, no publication, no extension.

**What is copied.** Every ordinary table in the current schema whose name
starts with the layout's `dataPrefix`, discovered from the catalog, minus the
fleet's own control tables and the layout's `excludedTables` (migration
bookkeeping). The fleet's control tables are never copied, so one backend can
never overwrite another's log.

**Source.** One `REPEATABLE READ READ ONLY` transaction. Rows are read through
a cursor in bounded batches, each row as a JSON object of its columns' *text*
forms.

**Target.** One transaction that either commits everything or leaves the
standby as it was:

1. Takes the fleet's exclusive advisory lock, without waiting. An assignment
   entry cannot arrive on this backend while the lock is held (the accept
   statement takes the shared form), and a second copy gets `busy`.
2. Reads the target's own newest log entry on the same session. It must be the
   assignment the caller resolved, and that assignment must name another
   backend as the writer. Otherwise: `target-is-writer` or `target-log-differs`.
3. Compares the catalog of the copied tables on both sides: same tables, same
   columns, same types. Otherwise `schema-mismatch`, naming the table or column.
4. Truncates the copied tables together and inserts the rows, casting each
   text value back to its column type.
5. Moves every sequence owned by a copied column to at least the source's
   position, and never backwards, so inserts on a promoted standby cannot
   collide with copied rows.
6. Digests every copied table again on the target and compares with the
   source. Otherwise `digest-mismatch`.
7. Writes the **watermark**: source backend, assignment epoch, snapshot time
   on the source's clock, rows and digest per table, and one digest over all.

Step 2 is what makes it impossible to overwrite the writer. A backend that is
the writer, or has been offered the entry that makes it one, holds that entry
(rule 3 above), so it refuses however stale the caller's view is.

**The copy on its own.** `copySnapshot({ source, target, layout, admit, record })`
is the same copy without the fleet's rule about who may be overwritten: the
source transaction, the row and byte limits, and steps 3 to 6. The caller
supplies `admit`, which runs on the target inside its transaction before any
copied table is read or changed, and `record`, which runs after the digests
matched and commits with the copied rows. A refusal is thrown as
`ReplicationRefused` (`oversized`, `schema-mismatch`, `digest-mismatch`), and
anything thrown rolls both transactions back. `replicateSnapshot` is
`copySnapshot` with steps 1 and 2 as `admit` and step 7 as `record`. It exists
for a one-off copy between two databases that are not a fleet and so have no
assignment log to consult; the CI relay's one-time import into a newly
selected store is that case, and its `admit` is "this store holds no
registration and no account".

**Why text and not JSON values.** `row_to_json` writes an SQL `NULL` and a
`json` column containing `null` identically, and `json_populate_recordset`
reads both back as SQL `NULL`. Sending each column as the text PostgreSQL
prints for its type, and casting it back, round-trips `bytea`, `bigint`,
`timestamptz`, `uuid`, `json`, `jsonb`, `numeric`, arrays and intervals
exactly. The session's `TimeZone`, `DateStyle`, `IntervalStyle`,
`extra_float_digits` and `bytea_output` are pinned in both transactions so two
servers with different defaults print the same bytes.

**The digest** is computed by the server in one pass with constant memory:
SHA-256 of each row, split into four 64-bit words, summed per word, hashed
again with the row count. It does not depend on row order. `readDataDigests`
returns the same list for any backend, so "these two backends hold the same
data" is one comparison.

**Lag.** `standbyLagMs(watermark, nowMs)` is the time since the snapshot was
taken. It is an upper bound on what promoting that standby would lose, not a
count of lost writes.

**Limits, stated plainly.**

- Cost grows with the size of the database, not with how much changed: every
  run reads and rewrites every row. `limits.maxRows` and `limits.maxBytes`
  (defaults 2,000,000 rows and 512 MiB of row text) turn a database that has
  outgrown this into the refusal `oversized` instead of a crash or a timeout.
- A standby is as stale as the interval between runs. That interval is the
  floor of any recovery point objective built on this.
- A foreign key from a table that is not copied into one that is makes the
  truncate fail; the copy is then rolled back and the error is thrown.
- Lag compares the caller's clock with the source's. Skew between them shifts
  it by the same amount.

### Policy: keep, switch, or fail over

`decideFleet(input)` is a pure function over the current assignment, one
observation per backend, one financial model per backend, the policy, the
billing period and the instant. It returns one action, its reasons, and every
standby ranked, so one log line of its result explains the decision.

| Action | When | What is lost |
|---|---|---|
| `keep` | The writer is healthy and nothing known is wrong with it, or something is and no standby is provably better | nothing |
| `switch` (planned) | The writer is healthy but a hard allowance is projected to run out within `exhaustionHorizonMs`, or the injected budget check refuses its next period; and a healthy, schema-current standby is feasible | nothing |
| `failover` (unplanned) | The writer has been failing for at least `failoverAfterMs`, and a reachable, schema-current standby has lag within `rpoMs` | up to the promoted standby's lag |
| `hold` | The writer is failing and it is too early, or no standby is within the objective; or a switch is in flight | nothing, and nothing moves |

**Observations** (`PostgresFleetObservation`): health (`reachable`, or the
failure class `unreachable`, `quota-exhausted`, `auth`, `unknown` from
`classifyFleetFailure`), probe latency, how long it has been failing, whether
its schema matches the writer's, its standby lag, and measured usage.

**Financial model** (`PostgresFleetFinancialModel`): a fixed monthly fee, and
allowances each in a named unit (`operations`, `compute-hours`,
`storage-bytes`) with what happens beyond (`hard-stop`, `metered` with a price,
or `unknown`), plus the evidence source and the day somebody read it. This
package holds no provider's numbers; a host supplies them.

**Unknown is a value.** A fee or an allowance that nobody has verified is
`undefined`, never a guess. The policy treats it the same way in both
directions: an unknown about the writer is not a reason to leave it, and a
standby with an unknown is never the target of a planned switch. A known
allowance whose overage is `unknown` is treated as a hard stop. A failover does
take a standby with unknowns, after any affordable one, because a relay that is
down costs more than a plan.

**Projection.** The fleet's workload is what the writer is measured to do: its
use this period divided by the time elapsed. On a candidate, time to exhaustion
is what remains of its allowance (after its own use so far) divided by that
rate. Storage is a level, compared with the writer's database size.

**No flapping.** A standby is switched to only if its hard allowances last
`hysteresisFactor` horizons (default 2), and a planned switch waits
`minDwellMs` after the previous decision. A backend the fleet just left stays
nearly spent until its period resets, so it is not a place to go back to.

**The budget is not decided here.** `checkBudget` is injected and is asked,
only when every fact is known, whether a period with a given cost bound and
projected use is affordable. `@hobo/ci-vercel` wires it to
`evaluateBudgetPolicy` from `@hobo/core`. This package cannot import it: the
neutrality test pins its one runtime dependency.

**The recovery point objective is not overridden here.** With every standby
older than `rpoMs` the answer is `hold`. Promoting anyway is
`overrideAssignment`, called by a person.

### The reconciler: one tick

`reconcileFleet(options)` is the only thing that changes who the writer is. A
host calls it on a schedule and injects `now`, `sleep`, the executors, the
schema seam and the budget check. Every tick, in order:

1. **Settle the assignment.** Complete an interrupted entry, repair short
   logs, write the first entry of an empty fleet (the first configured backend
   is its writer), and finish or undo a move that an earlier tick sealed.
   Without a decided assignment the tick stops: `undecided` or `no-majority`.
2. **Probe** every backend. A failing writer is probed again until it has
   failed for `failoverAfterMs`, so one tick tells a blip from an outage
   without remembering anything between ticks. One success ends the wait.
3. **Copy** the writer to every reachable standby. If a copy is refused for a
   schema mismatch, `ensureSchema(backend, role)` is called for both sides,
   the standby first (`role` is `"standby"`, then `"writer"`), and the copy is
   tried once more; `ensureSchema` is not called otherwise. The role is the
   backend's side under the assignment the tick resolved. It is there because
   the two sides are prepared differently: a host may bring the writer
   forward with its application's own initialisation, and must give a standby
   its schema without the application, which does not write to a standby. A
   copy compares tables and columns, not indexes, so a host that needs a
   standby's indexes current checks that itself; the relay does, from its
   migration ledger.
4. **Measure**: standby lag from each watermark, operations from each usage
   counter, storage from the database size.
5. **Decide** with `decideFleet`.
6. **Act** through the assignment register.

| Move | Entries written | What bounds the loss |
|---|---|---|
| Planned switch | `sealed = true, target = T`; wait `leaseMs + graceMs`; copy once more; `active = T` | Nothing is lost: nobody writes while sealed, and the final copy has lag 0 |
| Switch that cannot finish | `sealed = true, target = T`; the final copy fails; `active = old writer` again (`switch-aborted:<why>`) | Nothing: the old writer never stopped being the source |
| Unplanned failover | `active = T, loss_window_ms = T's lag` | Writes after T's snapshot are lost; `loss_window_ms` is the upper bound |

A backend that returns after losing the writer role holds an entry saying it
was the writer. Its log is repaired with the decided entries it missed, and it
is then a standby that the next copy overwrites. Until its log is repaired,
and whenever it really is the writer, the copy is refused on the backend
itself.

Two reconcilers can run at once. Every change is a compare-and-set on the
epoch; the loser gets `stale` or `refused` and stops. A reconciler that finds
another one finishing the same switch does not undo it.

Events are reported through `log` as data (`replication`, `decision`,
`transition`, `unsettled`): backend ids, numbers and fixed tokens only.

**What the reconciler does not do.**

- It does not promote a standby older than `rpoMs`, and it does not break a
  split epoch. Both are `overrideAssignment`, called by a person.
- It does not run between ticks. A writer that dies right after a tick is not
  replaced until the next one, so recovery time is up to one schedule interval
  plus `failoverAfterMs`, and what a failover loses is up to one interval of
  writes. With a recovery point objective smaller than the interval plus the
  tick's own duration, a failover always holds.
- With a majority of backends unreachable it changes nothing, and readers fail
  closed. That is by design: a double fault stops the application instead of
  risking two writers.
- Instances that can still reach an old writer the reconciler could not reach
  keep writing to it for at most one lease after a failover. Those writes are
  lost and are not counted in `loss_window_ms`.

### Usage metering

`createUsageMeter()` counts the statements a host sends per backend and
`flush` adds each count to a per-period row on that backend (`addUsage`,
`readUsage`, period ids from `billingPeriod`: the UTC calendar month). One
statement is one operation. A backend that cannot be reached keeps its count
for the next flush. The total is a lower bound: an instance stopped before it
flushes loses what it had not written. `measureStorageBytes` reads the
database size for a storage allowance.

## Error codes

`PostgresDataError.code` is one of `INVALID_POSTGRES_REQUIREMENT`,
`UNSAFE_COMMAND_ARGUMENT`, `MIGRATION_FAILED`, `CONFORMANCE_SUITE_INVALID`,
`CONFORMANCE_EXECUTOR_MISSING`, `FLEET_CONFIGURATION_INVALID`,
`FLEET_RECORD_INVALID`, and — from the engine binding —
`ENGINE_OPTIONS_INVALID`, `ENGINE_EXECUTOR_CONTRACT`, `CAPTURE_POSITION_INVALID`,
`CAPTURE_SUBSCRIPTION_LOST`, `CAPTURE_STREAM_UNDECODABLE`,
`CAPTURE_SLOT_UNPROVEN`, `NATIVE_SUBSCRIBE_FAILED`, `NATIVE_STOP_FAILED`,
`NATIVE_PAUSE_FAILED`. Each carries a structured `detail` naming the offending
field; `NATIVE_SUBSCRIBE_FAILED` and `NATIVE_STOP_FAILED` carry a SQLSTATE and
nothing else, because the server's own text can quote the connection string.
`CAPTURE_POSITION_INVALID` is raised as `@hobo/data-core`'s
`CapturePositionError`, the same class every engine raises.
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
| table prefixes | `parseFleetLayout` | `FleetLayout` | a control table that replication would copy, or an identifier that is not plain |
| a log row or a proposal | `parseFleetAssignment` | `PostgresFleetAssignment` | a sealed entry with no target, a target on an unsealed entry, a negative loss window |
| a plan's numbers | `parseFleetFinancialModel` | `PostgresFleetFinancialModel` | a metered allowance without a price, two allowances for one unit, numbers with no source or date |
| policy settings | `parseFleetPolicy` | `FleetPolicy` | a negative objective, a hysteresis factor below 1 |

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

The authoring, vocabulary, conformance, migration-profile and fleet surfaces
are a pure core: they hold no state, open no connection of their own, read no
clock, and append nothing by themselves. The fleet's statements go through an
injected executor and its instants through an injected `now`. Their outputs are
what the durable control plane carries.

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

### The fleet in the same vocabulary

- **Commands** — `proposeAssignment` (compare-and-set on the epoch),
  `completeAssignment`, `overrideAssignment`, `replicateSnapshot`. The
  reconciler is the **actor**: it consumes observations and issues these
  commands; it never edits a read model.
- **Events** — an assignment entry is the event (`bootstrap`, `seal`,
  `activate`, `unseal`, `failover` are its kinds, in `reason` and in the
  `transition` log record). Entries are immutable and totally ordered by epoch.
- **Event store** — each backend's assignment log table is a small
  **event store**: append-only, one writer per epoch by primary key, appended
  under a compare-and-set on the previous epoch. A majority of them agreeing is
  the commit.
- **Projections / materialized views** — the current assignment is the
  **projection** `resolveAssignment` folds from a majority of logs; a relay
  instance caches it for one lease. Usage counters are a materialized view of
  statements sent.
- **Snapshots / read store** — a standby is a **snapshot** of the writer's
  data and its watermark names the point in time; the standbys together are the
  **read store** a failover promotes from. Replay is copying decided entries
  onto a backend whose log is short.

## Tests

```bash
pnpm --filter @hobo/data-postgres run build
pnpm --filter @hobo/data-postgres run test
```

Offline and deterministic by default; no database is started and no clock is
read (the fleet takes `nowMs` as an argument; its SQL runs against real
PostgreSQL in `@hobo/ci-vercel`'s gated tests). The lanes pin, among other
things: a SQLite/D1-shaped candidate never satisfies `data.postgres/v1` while
Neon-shaped and Prisma-shaped candidates do; every argv builder rejects each
injection class in every interpolated field; the
conformance fold returns `unknown` rather than `pass` when an executor is
missing; the `pgoutput` decoder reads bytes recorded from a real server; and the
engine binding issues exactly the statements its executor pact names.

The engine binding's live lane — the engine conformance kit against a real
server, and capture under concurrency — runs only when `HOBO_TEST_POSTGRES_URL`
is set. See [Running the live lane](#running-the-live-lane).

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
in `data-models/postgres_capability.proto`, `postgres_engine.proto` and
`postgres_fleet.proto`, the CUE invariants in the matching `.cue` files, and the
Pact-shaped boundary contracts in
`contracts/pacts/postgres-conformance.pact.json`,
`postgres-engine-executor.pact.json`, `postgres-native-transfer.pact.json` and
`postgres-fleet.pact.json`.
