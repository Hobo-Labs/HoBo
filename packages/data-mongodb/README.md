# @hobo/data-mongodb

The MongoDB engine for HoBo's engine-neutral data contract
([ADR-0177](../../docs/design/adr/03-data-plane.md#adr-0177),
[design note](../../docs/design/data-engines-continuous-migration.md)): the
`data.mongodb/v1` profile and the `@hobo/data-core` SPI — datasets, records,
snapshot, change capture, apply, verify, write fence, retire — over an
**injected executor**. The runtime package imports no driver and no BSON
library.

```ts
import { createMongoEngine } from "@hobo/data-mongodb";

const engine = createMongoEngine({ executor }); // an EngineBinding
await engine.datasets.ensureDataset(schema);
await engine.records.write({ dataset: schema.name, mutations });
```

`executor` is anything that implements the [`MongoExecutor`](#the-executor-port)
port: the [reference adapter](#the-reference-driver-adapter) over the official
driver, or `createMemoryMongoExecutor()` for tests.

## What it declares

`mongoEngineDeclaration({ capture })`, parsed by `parseEngineDeclaration`:

| Field | Value | Why |
|---|---|---|
| `engine` / `profile` | `mongodb` / `data.mongodb/v1` | |
| `paradigm` | `document` | |
| `ports` | `datasets, records, snapshot, capture, apply, verify, fence, retire` | no `schema` port: there is no SQL surface, so `in-place-evolve` is ineligible by declaration |
| `captureOrdering` | `global` | a change stream is totally ordered by cluster time |
| `fenceEnforcement` | `entry-point` | MongoDB has no triggers — see [the fence](#the-fence-and-its-limit) |
| `snapshotConsistency` | `fuzzy` | the seed is a keyset scan, not a point-in-time image |
| `ddlTransactional` | `false` | |
| `nativeProfiles` | `[]` | no native fast path is claimed |

`createMongoEngine({ executor, capture: false })` is for a deployment that
cannot open change streams. The binding then has no `capture` port, the
declaration lists none and says `captureOrdering: "none"`, collections are
created without pre- and post-images, and every conformance case that needs
this engine's capture — `snapshot-and-tail` with it as the source — is skipped
rather than passed. `offline-copy` still runs and passes.

That option does **not** make a standalone `mongod` usable. A standalone
server has no change streams *and* no multi-document transactions, and the SPI
requires `write`, `apply`, and `retire` to be atomic. Against a standalone
MongoDB 8.0 every write is refused with `MONGODB_TRANSACTIONS_UNAVAILABLE`
(server code 20) and `capture.start` with `MONGODB_CAPTURE_UNAVAILABLE`
(40573); the binding does not degrade to non-atomic writes. Convert the server
to a single-node replica set.

## Document layout

One collection per dataset, named after it. One document per record:

```
{ _id: { t: <tenant>, k: <canonical key> }, <field>: <native value>, … }
```

- Tenant and key are the `_id`, so the `_id` index is the tenant index, a
  tenant is one contiguous `_id` range, and a delete event — which carries only
  the document key — still names both.
- Fields are top-level, in schema order, each in the BSON type the annex below
  names. Undeclared fields of an open schema go under `_open`, a name no
  declared field can take.
- The collection is created with a strict `$jsonSchema` validator
  (`datasetValidator(schema)`) that pins every declared field to its BSON type
  and refuses undeclared ones. A writer with its own connection cannot store a
  string where the schema says `long` without explicitly bypassing validation.

One metadata collection (`_hobo_data_engine` by default; the name must start
with `_`, which no dataset name can) holds the dataset schemas, the raised
fences, the apply watermarks, and the capture subscriptions. State lives in the
store, not in the binding: a second binding over the same database sees all of
it.

## Type-mapping annex

Every value is stored **exactly**, in the native type named here, or it is
**refused loudly**. Storing it altered is the one outcome that never happens.
The same table is `MONGO_TYPE_MAPPING` in the declaration.

| Canonical | Native BSON | Write | Read | Constraint or reason |
|---|---|---|---|---|
| `bool` | `bool` | exact | exact | |
| `int64` | `long` | exact | exact | always a 64-bit integer, never a double: `9007199254740993` survives |
| `float64` | `double` | exact | widening | a native NaN or infinity has no canonical form and is refused on read |
| `decimal` | `decimal` (Decimal128) | **constrained** | widening | at most 34 significant digits, exponent in [-6176, 6111]; a longer decimal is refused at write, never rounded. A native NaN or infinity is refused on read |
| `string` | `string` | **constrained** | exact | must be well-formed Unicode: an unpaired surrogate has no UTF-8 encoding (a driver would store U+FFFD) and is refused. NUL is fine |
| `bytes` | `binData` subtype 0 | exact | exact | |
| `timestamp` | `string`, RFC 3339 UTC with six fractional digits | exact | widening | **not** a BSON date: a BSON date is millisecond precision and would drop microseconds. The validator pins the layout, so text order is time order; text that is not a timestamp is refused on read |
| `date` | `date` at 00:00:00.000 UTC | exact | widening | a native instant that is not a UTC midnight in years 0000–9999 is refused on read |
| `uuid` | `binData` subtype 4 | exact | widening | the validator pins `binData` but not subtype or length; anything but 16 bytes of subtype 4 is refused on read |
| `json` | `object` / `array` / `string` / `double` / `bool` / `null` | **constrained** | widening | object keys may not start with `$` or contain NUL; strings must be well-formed; numbers are stored as doubles. A nested BSON value with no JSON form (date, ObjectId, Decimal128, a long beyond 2^53) is refused on read |
| `encrypted` | `object { alg, keyRef, ciphertext: binData }` | **constrained** | exact | ciphertext is stored as bytes and never interpreted; `alg` and `keyRef` are strings, so the well-formed rule applies |

No edge is `lossy`. `constrained` means what `@hobo/data-core` says it means: a
value outside the constraint throws `MONGODB_VALUE_NOT_REPRESENTABLE` before
the transaction opens, so the whole batch is refused and nothing is written.
The error names the field and the constraint and never quotes the value.

`read` is judged against the collection as this binding creates it, with its
validator in force. Where the native type is still wider than the canonical
one under that validator — a double can be NaN, a string can be any text — the
edge is `widening` and the stray value throws `MONGODB_NON_CANONICAL_VALUE` on
read. It is never coerced.

Why these choices: `decimal` keeps the native numeric type because Decimal128
is what makes money queryable and summable in MongoDB, and 35-digit decimals
are rare. `timestamp` gives the native type up because microsecond timestamps
are the norm — every `timestamptz` from PostgreSQL has them — and a
`constrained` BSON date would refuse most real rows.

## The executor port

`MongoExecutor` (`src/executor.ts`) is the one boundary that leaves the
package. Every request and result is a closed record of plain JSON; every BSON
value is **canonical MongoDB Extended JSON v2** — `{ "$numberLong":
"9007199254740993" }` is a 64-bit integer and cannot be mistaken for a double.

| Method | Contract |
|---|---|
| `ensureCollection({ collection, validator?, changeImages })` | create the collection, or converge an existing one onto these options; idempotent |
| `find({ collection, select, limit? })` | `select` is `{ kind: "ids", ids }` or `{ kind: "range", after?, before? }` (strict bounds); results are always in ascending `_id` order |
| `bulkWrite({ collection, operations })` | ordered `insert` / `replace` (whole-document upsert) / `delete` / `deleteRange`; returns `{ inserted, replaced, deleted }` |
| `transaction(body)` | run `body(session)` as one multi-document transaction — snapshot reads, all writes or none, majority-committed. `body` may be retried, and an error it throws aborts and is rethrown unchanged |
| `awaitTransactions({ collection })` | resolve once every transaction that had touched the collection has finished |
| `changeHead({ collection })` | the stream's current resume token: nothing committed before it is ever returned |
| `readChanges({ collection, after, limit, where? })` | events strictly after a token, in commit order, without consuming; `{ events, token, drained }` |
| `close()` | |

The port is deliberately narrower than MongoDB. Documents are addressed by
`_id` only, which is all the SPI needs and all served by the `_id` index, and
it leaves no query language for an implementation to get subtly wrong.

A refused command is a thrown `MongoCommandError` carrying the server's numeric
`code`, its `codeName`, and its labels — never the server's message, which can
quote a key or a whole document. The binding maps it to a `MongoDataError`
([error codes](#error-codes)).

Requests can cross a process boundary: `parseFindRequest`,
`parseBulkWriteRequest`, `parseEnsureCollectionRequest`,
`parseChangeReadRequest`, `parseChangeHeadRequest`, and
`parseAwaitTransactionsRequest` turn JSON into the typed request or refuse it.

The boundary is written down as a pact,
`contracts/pacts/mongo-executor.pact.json` — fifteen ordered interactions —
and the pact is executable: `test/executor-contract.test.ts` replays it against
the in-memory executor, and the live lane replays the same file against a real
replica set through the driver adapter.

### The reference driver adapter

`test/support/driver-executor.ts` is the reference adapter over the official
`mongodb` driver (a devDependency here; a host brings its own client):

```ts
import { MongoClient } from "mongodb";
import { createMongoEngine } from "@hobo/data-mongodb";
import { createMongoDriverExecutor } from "./driver-executor.js";

const client = new MongoClient(url); // resolved from a secretRef; never logged
const engine = createMongoEngine({
  executor: createMongoDriverExecutor({ client, database: "app" }),
});
```

It is a mechanical translation — closed request records into driver calls, and
Extended JSON to and from BSON with the driver's own `EJSON`. Three things in it
are load-bearing:

- reads use `promoteValues: false`, or the driver hands an int64 back as a
  JavaScript number and silently loses everything beyond 2^53;
- driver errors raised inside a transaction body pass through untouched,
  because `withTransaction` retries on the driver's own error labels;
- change streams are driven with raw `aggregate` / `getMore` commands rather
  than `watch()`, so every batch boundary and resume token is visible and
  `drained` is true only after the stream reported nothing further twice at
  one unchanged resume point.

Beyond reading and writing the database, the adapter opens change streams and
runs `collMod` (for `ensureCollection` and `awaitTransactions`), so with access
control on the database user needs those actions too. The live lane's server
runs without access control, so the exact role set is not proven here.

### The in-memory executor

`createMemoryMongoExecutor()` implements the same port with no server, so the
conformance kit and the cross-engine runs are always-on tests. It is faithful
where a test would otherwise be fooled: values come back the way a driver
returns them (a Decimal128 in scientific notation when a server would print it
so, an unpaired surrogate as U+FFFD), `_id` order is BSON order (UTF-8 bytes,
not UTF-16 code units), the `$jsonSchema` validator is enforced and an
unimplemented keyword is an error rather than a silent pass, a no-op write
emits no event, and a transaction is all or nothing. The live lane writes the
same documents through both executors and asserts identical answers.

It does not model the 16 MiB document limit, nesting limits, the oplog window,
or transaction size and lifetime limits, and it serialises every operation.

## Capture semantics

Capture is a MongoDB change stream on the dataset's collection. A position is
a resume token as opaque text.

- **`start`** persists the subscription with the stream's current resume token
  and returns it. Starting an existing subscription returns its *original*
  position, from any binding. Changes committed before `start` are never
  returned.
- **`read`** returns changes strictly after `after`, in commit order, at most
  `limit` of them, and does not consume: a repeated read from the same position
  repeats. A token can sit in the middle of a transaction, so a limit may split
  one. `caughtUp` is true only when the stream had nothing further; the
  returned `position` then covers everything the stream considered, including
  changes outside the scope, so the next read does not rescan them.
- **Tenant scope** is a `$match` on `documentKey._id.t`, evaluated by the
  server.
- **An upsert carries the record as of that change.** Every write through the
  binding is a whole-document replace, whose event carries the document it
  wrote. An in-place update by another client is still captured as of the
  change, because collections keep pre- and post-images
  (`changeStreamPreAndPostImages`) and the stream is read with
  `fullDocument: "required"`. `updateLookup` is never used: it returns today's
  document, which reorders history.
- **A delete carries tenant and key**, from the document key.
- **`acknowledge` is a no-op.** MongoDB keeps no per-reader log; retention is
  the oplog window and nothing an acknowledgement could release.
- **`stop`** removes the subscription.

What capture does not do:

- A write that changes nothing — an identical replace, a delete of an absent
  record — produces no event. Convergence is unaffected.
- A position is resumable only while the oplog still holds it. A reader that
  falls outside the window gets `MONGODB_CAPTURE_POSITION_LOST` and must
  re-seed.
- A `drop`, `rename`, or `invalidate` event is refused with
  `MONGODB_CAPTURE_UNSUPPORTED_EVENT`. It is not a record change the contract
  can carry, and skipping it would be silent data loss.

## The fence, and its limit

`fenceEnforcement` is `entry-point`, and that is a real limit: **MongoDB has no
triggers, so a client holding its own connection can still write to a fenced
dataset.** The fence stops every write that goes through this binding and
nothing else. The live lane pins this with a test that writes around a raised
fence, so nobody mistakes it for `store` enforcement.

Within that limit it is exact:

- A fence is a document in the metadata collection. `raise` is idempotent and
  returns the existing token; `release` needs the token
  (`FENCE_TOKEN_MISMATCH`); a fence on tenant `""` covers every tenant.
- Every `write`, `apply`, and `retire` is one transaction whose **first
  statement** reads the fences, so the check and the write see one snapshot. A
  fenced tenant anywhere in a batch refuses the whole batch with
  `FencedWriteError` unless the request carries the token.
- `raise` then calls `awaitTransactions` on the metadata collection. Snapshot
  isolation alone would let a writer that read "not fenced" a moment earlier
  commit *after* the fence did; the adapter issues a no-op `collMod`, whose
  exclusive lock is granted only once every transaction that has read the
  fences has finished. When `raise` returns, no unfenced write through the
  binding is still in flight.

## Atomicity and its bounds

`write`, `apply` (changes and watermark together; an empty batch still advances
the watermark), fence release, and `retire` (token check, digest, and delete in
one snapshot) are each one multi-document transaction. That is also the bound:
one transaction lives at most 60 seconds by default and is limited by cache, so
a very large write batch, or a retire over a very large scope, is refused by
the server (`MONGODB_TRANSACTION_LIMIT`) rather than applied in part. `verify`
and `snapshot` are paged keyset scans outside a transaction.

## Honest limits

The closed impedance list in the declaration (`MONGO_IMPEDANCE_CODES`,
[ADR-0144](../../docs/design/adr/07-portability-extensibility.md#adr-0144)):

| Code | Limit |
|---|---|
| `MONGODB_FENCE_ENTRY_POINT` | the fence stops writers that go through the binding, not a client with its own connection |
| `MONGODB_REPLICA_SET_REQUIRED` | change streams and transactions need a replica set or sharded cluster; a standalone server is not supported |
| `MONGODB_CAPTURE_OPLOG_WINDOW` | a position is resumable only while the oplog holds it |
| `MONGODB_CAPTURE_SKIPS_NOOP_WRITES` | a write that changes nothing produces no change event |
| `MONGODB_CAPTURE_NEEDS_CHANGE_IMAGES` | an in-place update is captured as of the change only while the collection keeps pre- and post-images; they cost a write per change |
| `MONGODB_TRANSACTION_BOUNDS` | one atomic unit is one transaction: bounded in lifetime and size |
| `MONGODB_DOCUMENT_SIZE_LIMIT` | a record is one BSON document: at most 16 MiB |
| `MONGODB_DECIMAL128_PRECISION` | 34 significant digits; longer decimals are refused |
| `MONGODB_TIMESTAMP_STORED_AS_TEXT` | timestamps are canonical text, not BSON dates, to native queries |
| `MONGODB_TEXT_WELL_FORMED_ONLY` | text with an unpaired surrogate is refused |
| `MONGODB_JSON_KEY_RESTRICTIONS` | JSON keys may not start with `$` or contain NUL; JSON numbers are doubles |
| `MONGODB_SNAPSHOT_FUZZY` | the seed scan is not a point-in-time image; the executors converge it with the tail |
| `MONGODB_NO_SCHEMA_PORT` | no SQL surface, no transactional DDL, no `in-place-evolve` |
| `MONGODB_NATIVE_OBJECTS_NOT_CARRIED` | indexes, collations, views, time-series and capped options, and server-side functions do not cross the hub |

Also true, and not yet covered by anything here: the binding has been proven
against a single-node replica set on MongoDB 8.0 only. Sharded clusters,
multi-node failover during a transaction, and Atlas-specific limits are
untested. There is no authoring helper, capability vocabulary, or native
migration profile for `data.mongodb/v1` in this package yet.

## Error codes

`MongoDataError.code` is one of `MONGO_DATA_ERROR_CODES`:

| Code | Meaning |
|---|---|
| `MONGODB_INVALID_OPTIONS` | the engine options were refused at construction |
| `MONGODB_INVALID_REQUEST` | a port or a wire parser was given an argument outside its contract |
| `MONGODB_VALUE_NOT_REPRESENTABLE` | a canonical value falls outside its native type's constraint; `detail` names the field, type, and constraint |
| `MONGODB_NON_CANONICAL_VALUE` | a stored value has no canonical form; it was written outside the binding |
| `MONGODB_DOCUMENT_REJECTED` | the collection validator refused the document (server code 121) |
| `MONGODB_DOCUMENT_TOO_LARGE` | the document exceeds 16 MiB (10334) |
| `MONGODB_TRANSACTIONS_UNAVAILABLE` | no multi-document transactions (20, 263) |
| `MONGODB_TRANSACTION_LIMIT` | a transaction outgrew its size or lifetime (257, 290) |
| `MONGODB_CAPTURE_UNAVAILABLE` | no change streams (40573) |
| `MONGODB_CAPTURE_POSITION_LOST` | the position is out of the oplog window or is not a resume token (286, 280, 260) |
| `MONGODB_CAPTURE_UNSUPPORTED_EVENT` | the stream reported an event that is not a record change |
| `MONGODB_COMMAND_FAILED` | any other refused command; `detail.serverCode` names it |

Contract refusals stay `DataCoreError`s so they mean the same on every engine:
`FENCED_WRITE` (`FencedWriteError`), `FENCE_TOKEN_MISMATCH`, `RETIRE_REFUSED`,
`INVALID_DATASET_SCHEMA`, `INVALID_RECORD`.

No error carries a server message, a record value, or a connection string:
`detail` holds field names, type names, and numeric codes only.

## Parse, don't validate

Untrusted input crosses one parse boundary and becomes a derived domain type
the rest of the package accepts as-is:

| Raw input | Parser | Derived domain type | Impossible afterwards |
|---|---|---|---|
| engine options | `parseMongoEngineOptions` | `MongoEngineSettings` | a metadata collection that could be a dataset's collection; a zero page size |
| a declaration | `parseEngineDeclaration` (via `mongoEngineDeclaration`) | `EngineDeclaration` | a `capture` port with ordering `none`, or the reverse |
| a record to store | `parseCanonicalRecord`, then `encodeDocument` | a `MongoDocument` in native types | a non-normalised value reaching BSON; a value its native type cannot hold being stored |
| a stored document | `decodeDocument`, then `parseCanonicalRecord` | a `CanonicalRecord` | a native NaN, a foreign BSON type, or an undeclared field becoming a canonical value |
| a schema read back from metadata | `parseDatasetSchema` | `DatasetSchema` | a stored schema being trusted because it was stored |
| a JSON executor request | `parseFindRequest` and its siblings | the typed request record | an unknown selector or operation kind reaching an executor |
| a refused command | `toMongoDataError` | `MongoDataError` | a server message — and whatever it quotes — reaching a caller |

`encodeDocument` runs `parseCanonicalRecord` itself, so the per-type encoders
only ever see canonical values and never re-check them. The protobuf records
in `data-models/data_mongodb.proto` are the wire projection of these parsed
types, and `data_mongodb.cue` carries their invariants — a selector is a set of
ids or a range and never both, each write kind carries exactly its own fields,
a resume token is never empty.

## Event architecture

This package is a store adapter. It appends to no event log and reads no
clock; what it holds, it holds in MongoDB. Its place in HoBo's event-driven
shape is as the effect a durable actor calls, and it is worth being exact about
which of its outputs are events and which are not.

- **Commands** — `WriteRequest`, `ApplyRequest`, `FenceRaiseRequest`,
  `FenceReleaseRequest`, and `RetireRequest` are the commands this engine
  accepts. Each is one transaction, each is idempotent under redelivery
  (upserts and deletes in order; `raise` returns the existing token), and each
  is refused as a whole or applied as a whole.
- **Events** — two different things, deliberately kept apart. A
  `ChangeEnvelope` from the capture port is a *transport record*: it carries a
  record, passes from a capture port to an apply port, and is then gone. The
  **events** are the `migration.*` facts the `@hobo/data-core` executors emit —
  `migration.PhaseApplied`, `migration.Verified`, `migration.CutOver`,
  `migration.Held`, `migration.Completed` — and what this package contributes
  to their bodies is evidence only: resume tokens, watermarks, counts, digests.
  Never a record, never a credential.
- **Actor** — the migration aggregate (`MigrationRun` in `@hobo/data-core`) is
  the single-writer **actor**. It folds the facts, decides the next phase, and
  calls these ports. The fence token is its fencing token: after cutover the
  old authority refuses every command that does not present it.
- **Event store** — the `MigrationJournal` the host supplies, in production
  HoBo's durable SQLite-backed **event store**
  ([ADR-0135](../../docs/design/adr/03-data-plane-sqlite-default.md)). MongoDB is
  never the event store, and the oplog is not one either: it is MongoDB's own
  log, read through change streams as a capture source and for nothing else.
- **Projections / materialized views** — a dataset fed by `apply` is a
  **materialized view** of its source stream. The watermark is committed in
  the same transaction as the changes it covers, so the view is always exactly
  at its watermark and a redelivered batch is harmless. The folded
  `MigrationState` is the **projection** of the migration facts.
- **Snapshots / read store** — `openSnapshot` is the seed image a new view
  starts from; it is fuzzy, and the tail replayed from a position taken before
  the scan converges it. The dataset collections are the **read store** behind
  `records.read` and `verify.digest`, and the metadata collection keeps each
  subscription's start and each view's watermark, so a restarted run resumes
  from a durable position instead of rebuilding.

## Tests

```bash
pnpm --filter @hobo/data-mongodb run build
pnpm --filter @hobo/data-mongodb run test
```

Always on, no database: the conformance kit (`runEngineConformance`) over the
in-memory executor — as engine and peer, and cross-engine against the reference
engine in both directions — plus the codec, the declaration, error mapping, the
pact replay, and the in-memory executor's own fidelity.

The live lane is `test/live.test.ts`, gated on `HOBO_TEST_MONGODB_URL` and
skipped cleanly without it. It needs a replica set (a single node is enough):

```bash
HOBO_TEST_MONGODB_URL='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' \
  pnpm --filter @hobo/data-mongodb exec vitest run test/
```

It runs the same kit against real MongoDB — as engine and peer, MongoDB →
reference, and reference → MongoDB — replays the pact through the driver
adapter, compares the in-memory executor with the server document for
document, and proves what only a server can: a native in-place update captured
as of its change, the validator refusing a native wrong-type write, a write
stalled across `raise` being waited out, and a client with its own connection
writing around the fence. Every binding gets its own database, dropped on
close; the lane fails if one is left behind. The connection string is read from
the environment and never logged, recorded, or put in a fixture.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
in `data-models/data_mongodb.proto`, the CUE invariants in
`data-models/data_mongodb.cue`, and the pact in
`contracts/pacts/mongo-executor.pact.json`.
