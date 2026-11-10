# @hobo/data-postgres

The provider-neutral PostgreSQL surface: how an app **asks** for a Postgres
database, what a Postgres product **advertises**, how that advertisement is
**proven**, and how data **leaves**.

No provider name appears anywhere in this package, and nothing in `src/` imports
a provider. That is enforced by a test, not by convention — `test/neutrality.test.ts`
scans the built API surface and the source tree for provider identifiers.

## The five things this package owns

| Concern | Entry point |
|---|---|
| Authoring an ask | `postgres.database({ version, extensions, migration })` |
| The advertised vocabulary | `POSTGRES_GUARANTEES`, `POSTGRES_FEATURES`, `postgresCapability(key)` |
| Proving the advertisement | `postgresConformanceSuite`, `planPostgresConformance`, `runPostgresConformance` |
| Getting the data out | `POSTGRES_MIGRATION_PROFILES`, `buildPgDumpArgv`, `buildPgRestoreArgv`, `buildLogicalCopyPlan` |
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
  backends down, 29 ended that way; 25 of those were fleets of two or four.

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
`FLEET_RECORD_INVALID`. Each carries a structured `detail` naming the
offending field.

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
claim `pg-dump` compatibility.

## Event architecture

This package is a pure core: it holds no state, opens no connection, reads no
clock, and appends nothing. Its outputs are what the durable control plane
carries.

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

## Tests

```bash
pnpm --filter @hobo/data-postgres run build
pnpm --filter @hobo/data-postgres run test
```

Offline and deterministic; no database is started and no clock is read (the
fleet takes `nowMs` as an argument; its SQL runs against real PostgreSQL in
`@hobo/ci-vercel`'s gated tests). The
lanes pin, among other things: a SQLite/D1-shaped candidate never satisfies
`data.postgres/v1` while Neon-shaped and Prisma-shaped candidates do; every
argv builder rejects each injection class in every interpolated field; and the
conformance fold returns `unknown` rather than `pass` when an executor is
missing.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
in `data-models/postgres_capability.proto` and `data-models/postgres_fleet.proto`,
the CUE invariants in `data-models/postgres_capability.cue` and
`data-models/postgres_fleet.cue`, and the Pact-shaped boundary contracts in
`contracts/pacts/postgres-conformance.pact.json` and
`contracts/pacts/postgres-fleet.pact.json`.
