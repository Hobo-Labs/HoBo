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
created without the change-image option, and every conformance case that needs
this engine's capture — `snapshot-and-tail` with it as the source — is skipped
rather than passed. `offline-copy` still runs and passes.

That option does **not** make a standalone `mongod` usable. A standalone
server has no change streams *and* no multi-document transactions, and the SPI
requires `write`, `apply`, and `retire` to be atomic. The binding does not
degrade to non-atomic writes: a write the server refuses for want of
transactions (server codes 20, 263) surfaces as
`MONGODB_TRANSACTIONS_UNAVAILABLE`, and a stream it refuses for want of a
replica set (40573) as `MONGODB_CAPTURE_UNAVAILABLE`. Those mappings are tested
with an executor that reports the codes; no lane here runs a standalone
server, so that a standalone 8.0 answers with exactly these codes is not
proven in this package. Convert the server to a single-node replica set.

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
| `ensureCollection({ collection, validator?, changeImages })` | create the collection, or converge an existing one onto these options; idempotent. `changeImages` is the collection option `changeStreamPreAndPostImages` |
| `find({ collection, select, limit? })` | `select` is `{ kind: "ids", ids }` or `{ kind: "range", after?, before? }` (strict bounds); results are always in ascending `_id` order |
| `bulkWrite({ collection, operations })` | ordered `insert` / `replace` (whole-document upsert) / `delete` / `deleteRange`; returns `{ inserted, replaced, deleted }` |
| `transaction(body)` | run `body(session)` as one multi-document transaction — snapshot reads, all writes or none, majority-committed. `body` may be retried, and an error it throws aborts and is rethrown unchanged |
| `awaitTransactions({ collection })` | resolve once every transaction that had touched the collection has finished |
| `changeHead({ collection })` | the stream's current resume token: nothing committed before it is ever returned |
| `readChanges({ collection, after, limit, where? })` | at most `limit` events strictly after a token, in commit order, without consuming; `{ events, token, drained }`. An event made inside a transaction carries that transaction's identity; only a full page may end inside one. `where` filters record events by document key and never removes a drop, a rename, or an invalidate. A token the deployment cannot decode is refused with code 260 |
| `close()` | |

The port is deliberately narrower than MongoDB. Documents are addressed by
`_id` only, which is all the SPI needs and all served by the `_id` index, and
it leaves no query language for an implementation to get subtly wrong.

A refused command is a thrown `MongoCommandError` carrying the server's numeric
`code`, its `codeName`, and its labels — never the server's message, which can
quote a key or a whole document, and never the driver's error as `cause`:
`MongoCommandError` takes a failure record and nothing else, and drops a code
name or label that is not a plain identifier. The binding maps it to a
`MongoDataError` ([error codes](#error-codes)), which has no `cause` either.

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

Its reads and writes are a mechanical translation — closed request records
into driver calls, and Extended JSON to and from BSON with the driver's own
`EJSON`. The rest is not, and the adapter is some four hundred lines of code
because of it. Six things in it are load-bearing:

- reads use `promoteValues: false`, or the driver hands an int64 back as a
  JavaScript number and silently loses everything beyond 2^53;
- driver errors raised inside a transaction body pass through untouched,
  because `withTransaction` retries on the driver's own error labels;
- a driver error is translated to its code and class name and then dropped,
  never chained as `cause`: its message quotes keys, documents, and the
  address the client dialled;
- change streams are driven with raw `aggregate` / `getMore` commands rather
  than `watch()`, so every batch boundary and resume token is visible and
  `drained` is true only after the stream reported nothing further twice at
  one unchanged resume point;
- a tenant filter is `$or`-ed with "any event that is not an insert, update,
  replace, or delete", so a drop reaches a tenant-scoped reader;
- a stream is opened with no events in its first batch, so the open fails only
  for the stream itself. If the server refuses to open it at the caller's
  token with a code that does not already name the position (260, 280, 286)
  and the same stream opens without the token, the adapter reports 260. The
  server has no single code for a token it cannot decode: asked directly, it
  gives the live lane's six malformed tokens six different codes, none of them
  260.

It also refuses a write statement of 16 MiB or more itself, with the server's
code for an oversized document (10334). The driver would refuse the same
statement before sending it, with an error that has a message and no code.
Because the driver measures the whole statement, a *replace* is refused a few
dozen bytes below 16 MiB of document — the filter is counted too.

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
emits no event, a document of 16 MiB or more is refused with code 10334, and
the events of a transaction carry one transaction identity. The live lane
writes the same documents through both executors and asserts identical
answers.

Transactions interleave, which is what lets the offline lane lose a race:

- a transaction reads the snapshot taken at its first statement and does not
  see a commit made after it;
- a write to a document that another transaction changed — committed since the
  snapshot, or still staged — is a write conflict (code 112, labelled
  transient): the transaction aborts and its body is run again, as a driver
  would. A write outside a transaction waits for the transaction that holds
  its document;
- a commit is never instant. It takes one turn of the event loop, during which
  the transaction is still open. A writer that read "not fenced" is therefore
  still in flight when a `raise` that skips `awaitTransactions` returns, and
  the kit's `fence.raise-waits-for-in-flight-writes` case fails — every time,
  not sometimes; `test/conformance.test.ts` pins that;
- `awaitTransactions` resolves once every transaction that had read or written
  the collection has committed or aborted.

`dropCollection(name)` is the one thing on it that is not on the port: what a
client with its own connection can do behind the binding's back. The stream
then reports a `drop` and an `invalidate`, as a server does.

It does not model nesting limits, the oplog window, or transaction size and
lifetime limits, and it has no in-place update, so an `update` event with a
derived post-image exists only in the live lane. It is also more forgiving
than a server about positions: it resumes any token under any filter, where a
server refuses one taken inside a transaction at another scope's event.

## Capture semantics

Capture is a MongoDB change stream on the dataset's collection. A position is
a resume token as opaque text.

- **`start`** persists the subscription with the stream's current resume token
  and returns it. Starting an existing subscription on the same scope returns
  its *original* position, from any binding. Changes committed before `start`
  are never returned. A subscription is one reader of one scope: starting an
  existing name on another dataset or tenant is refused with
  `MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT`, because the first scope's position
  means nothing to the second. `stop` frees the name.
- **`read`** returns changes strictly after `after`, in commit order, and does
  not consume: a repeated read from the same position repeats. **A batch never
  splits a source transaction.** It holds at most `limit` changes unless the
  last of them is inside a transaction, in which case it runs on to the end of
  that transaction — so one `records.write` or `apply` of 5,000 records is one
  batch of 5,000 whatever the limit. Events are grouped by the session id and
  transaction number the change stream reports. A bulk write made *outside* a
  transaction by another client is not one atomic unit and may be split.
  `caughtUp` is true only when the stream had nothing further; the returned
  `position` then covers everything the stream considered, including changes
  outside the scope, so the next read does not rescan them.
- **A position belongs to the scope that read it.** A batch's `position` and
  every envelope's `position` resume under the same scope. Under a different
  tenant scope a position taken inside a transaction, at another tenant's
  change, is refused by the server (code 280, `MONGODB_CAPTURE_POSITION_LOST`):
  the filtered stream never contains that event.
- **Tenant scope** is a `$match` on `documentKey._id.t`, evaluated by the
  server, that lets every event which is not about one document through.
- **An upsert carries the record as of that change.** Every write through the
  binding is a whole-document replace, whose event carries the document it
  wrote. An in-place update by another client is still captured as of the
  change, because the collection is created with
  `changeStreamPreAndPostImages` and the stream is read with
  `fullDocument: "required"`. `updateLookup` is never used: it returns today's
  document, which reorders history.
- **Only the post-image is read.** The binding never asks for
  `fullDocumentBeforeChange`. The option is still the one to set, and both
  halves of its name are honest about the cost: MongoDB has no
  post-image-only switch, because what the server stores is the *pre-image* of
  every updated, replaced, or deleted document, and it builds an update's
  post-image from that and the update's delta. The live lane checks this: after
  two native updates the server holds two pre-images and the capture returns
  the two post-images, which are stored nowhere. That stored pre-image — one
  extra write per change, for the binding's own writes too — is what
  `MONGODB_CAPTURE_NEEDS_CHANGE_IMAGES` is about. Without the option an
  in-place update makes the read fail (server code 47, surfaced as
  `MONGODB_COMMAND_FAILED`) rather than return a wrong document.
- **A delete carries tenant and key**, from the document key.
- **`acknowledge` is a no-op.** MongoDB keeps no per-reader log; retention is
  the oplog window and nothing an acknowledgement could release.
- **`stop`** removes the subscription.

What capture does not do:

- A write that changes nothing — an identical replace, a delete of an absent
  record — produces no event. Convergence is unaffected.
- A position is resumable only while the oplog still holds it. A reader that
  falls outside the window gets `MONGODB_CAPTURE_POSITION_LOST` and must
  re-seed. So does a reader that presents text that is not a resume token:
  the read is refused, never answered with an empty batch.
- A `drop`, `rename`, or `invalidate` event is refused with
  `MONGODB_CAPTURE_UNSUPPORTED_EVENT`, for an all-tenant reader and a
  tenant-scoped one alike. It is not a record change the contract can carry,
  and skipping it would be silent data loss.

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
  binding is still in flight. Both lanes can lose this race: the in-memory
  executor interleaves transactions, so a binding that skipped the wait fails
  the kit offline as well as against a server.

## Atomicity and its bounds

`write`, `apply` (changes and watermark together; an empty batch still advances
the watermark), fence release, and `retire` (token check, digest, and delete in
one snapshot) are each one multi-document transaction. A conditional apply
(`expectedWatermark`) reads the watermark entry inside the transaction that
replaces it and refuses with `StaleApplyError` when it is not the one named.
Two appliers naming the same watermark both write that one entry, so the
server commits one and makes the other run again, and its second reading finds
the watermark moved. A mutation whose key is
not the key of its record is refused (`INVALID_RECORD`) before the transaction
opens. That is also the bound:
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
| `MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING` | MongoDB keeps no per-reader log and a resume token is opaque, so `acknowledge` releases nothing, records nothing and checks nothing: any position is accepted, and a read from before an acknowledged one still succeeds while the oplog holds it. The conformance kit reports `capture.acknowledged-positions-are-final` as `declared-limit` for this engine (`MONGO_CONFORMANCE_DECLARED_LIMITS`) — recorded in the report, not counted as a pass — and would fail it if the engine turned out to hold the property |
| `MONGODB_CAPTURE_SKIPS_NOOP_WRITES` | a write that changes nothing produces no change event |
| `MONGODB_CAPTURE_NEEDS_CHANGE_IMAGES` | an in-place update by another client is captured as of the change only while the collection has `changeStreamPreAndPostImages` on; the server then stores a pre-image for every change, which costs a write per change |
| `MONGODB_TRANSACTION_BOUNDS` | one atomic unit is one transaction: bounded in lifetime and size |
| `MONGODB_DOCUMENT_SIZE_LIMIT` | a record is one BSON document: under 16 MiB. The declaration states the bound as `maxRecordBytes` (`MONGO_MAX_RECORD_BYTES`, 16 MiB); a batch carrying a larger record is refused whole, since a batch is one transaction |
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

`MongoDataError.code` is one of `MONGO_DATA_ERROR_CODES`. Every row is produced
through a port by a test; the last column says by which lane, and is explicit
where a server has not been seen to produce it.

| Code | Meaning | Produced by |
|---|---|---|
| `MONGODB_INVALID_OPTIONS` | the engine options were refused at construction | offline |
| `MONGODB_INVALID_REQUEST` | a port or a wire parser was given an argument outside its contract | offline |
| `MONGODB_VALUE_NOT_REPRESENTABLE` | a canonical value falls outside its native type's constraint; `detail` names the field, type, and constraint | offline and live |
| `MONGODB_NON_CANONICAL_VALUE` | a stored value has no canonical form; it was written outside the binding | offline (codec) and live (a native NaN) |
| `MONGODB_DOCUMENT_REJECTED` | the collection validator refused the document (server code 121) | live, by tightening the validator natively; offline, by an executor reporting 121 |
| `MONGODB_DOCUMENT_TOO_LARGE` | the document is 16 MiB or more (10334) | offline, by the in-memory executor; live, by the adapter, which refuses the statement before the driver would. A server was never asked |
| `MONGODB_TRANSACTIONS_UNAVAILABLE` | no multi-document transactions (20, 263) | offline only, by an executor reporting the code. No standalone server in any lane |
| `MONGODB_TRANSACTION_LIMIT` | a transaction outgrew its size or lifetime (257, 290) | offline only, by an executor reporting the code. Not provoked on a server |
| `MONGODB_CAPTURE_UNAVAILABLE` | no change streams (40573) | offline only, by an executor reporting the code |
| `MONGODB_CAPTURE_POSITION_LOST` | the position cannot be resumed from: it is not a resume token (260), it is not in this reader's stream (280), or it has left the oplog window (286) | 260 offline and live; 280 live; 286 offline only, by an executor reporting the code |
| `MONGODB_CAPTURE_UNSUPPORTED_EVENT` | the stream reported an event that is not a record change; `detail.operation` names it | offline and live, all-tenant and tenant-scoped |
| `MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT` | the subscription name already reads another dataset or tenant | offline and live |
| `MONGODB_COMMAND_FAILED` | any other refused command; `detail.serverCode` names it, or is 0 with the driver's error class in `detail.codeName` when no server answered | offline, by an unknown code and by a client that cannot reach its server |

Contract refusals stay `DataCoreError`s so they mean the same on every engine:
`FENCED_WRITE` (`FencedWriteError`), `FENCE_TOKEN_MISMATCH`, `RETIRE_REFUSED`,
`INVALID_DATASET_SCHEMA`, `INVALID_RECORD`.

No error the binding or the reference adapter throws carries a server message,
a record value, or a connection string — in its message, in its `detail`, or
behind a `cause`. `detail` holds field names, dataset names, type and
constraint names, operation names, numeric codes, and code names — and, on a
`FencedWriteError`, the tenant that is fenced. Neither error class's
constructor accepts a `cause`; the binding builds its error from a refusal's
code and name alone, so whatever an executor hung on the refusal is left
behind; and a code name, a label, or an operation name is kept only if it is a
plain word. The tests assert this on `util.inspect(error)` at unlimited depth,
with hidden properties: offline against an executor that hangs a server
message on its refusal, without a server against a client given a password
and a dead address, and live against a duplicate key and a validator failure.

What that does not cover: an executor that throws something other than a
`MongoCommandError`. The binding passes such an error through unchanged — it is
a bug in the executor, and hiding it would hide the bug — so an adapter that
lets a raw driver error escape leaks whatever that error holds.

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
| a refused command | `new MongoCommandError`, then `toMongoDataError` | `MongoDataError` | a server message — and whatever it quotes — reaching a caller, in a field or behind a `cause` |
| a batch of change events | `readWholeTransactions` in `capture.read` | a `CaptureBatch` | a batch that ends inside a source transaction |

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
  accepts. Each is refused as a whole or applied as a whole, and each is
  idempotent under redelivery: upserts and deletes in order; `raise` returns
  the existing token; releasing a fence that is already down does nothing; and
  a `retire` redelivered after it committed — the scope is empty and the fence
  is still held by the presented token — answers `{ removed: 0 }` instead of
  `RETIRE_REFUSED`, so a crash between the retire and the caller hearing of it
  does not wedge the run. Every other retire refusal stands: no fence, another
  token, or a scope that is neither empty nor what was proven. `write`,
  `apply`, release, and `retire` are each one transaction; `raise` is an insert
  followed by a wait.
- **Events** — two different things, deliberately kept apart. A
  `ChangeEnvelope` from the capture port is a *transport record*: it carries a
  record, passes from a capture port to an apply port, and is then gone. The
  **events** are the `migration.*` facts the `@hobo/data-core` executors emit —
  `migration.PhaseApplied`, `migration.Verified`, `migration.CutOver`,
  `migration.Held`, `migration.Completed`. What this package hands the
  executors for them is resume tokens, watermarks, counts, and digests — never
  a record, never a connection credential. It also hands them a fence token,
  and that is not evidence: it is a capability, since whoever presents it can
  write through the fence and retire the scope. What of it reaches a journal is
  decided in `@hobo/data-core`, not here.
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

| Lane | Needs | Runs | Cannot show |
|---|---|---|---|
| Offline | nothing | the conformance kit (`runEngineConformance`) over the in-memory executor — as engine and peer, and cross-engine against the reference engine in both directions — the codec, the declaration, error mapping, the pact replay, the binding's own edges, and the in-memory executor's fidelity, including interleaved transactions | anything the in-memory executor does not model: a native in-place update and its derived post-image, the oplog window, transaction size and lifetime limits, a standalone server, and which code a server gives a malformed resume token. The fence race **is** shown: a binding that skips the wait fails `fence.raise-waits-for-in-flight-writes` on every run |
| No server | loopback only | `test/driver-adapter.test.ts`: the reference adapter with a client whose server does not exist — what an unreachable server turns into, and the size refusal | anything that needs an answer from a server |
| Live | `HOBO_TEST_MONGODB_URL`, a replica set (one node is enough) | `test/live.test.ts`: the same kit against real MongoDB — as engine and peer, MongoDB → reference, reference → MongoDB — the pact through the driver adapter, the in-memory executor compared with the server, and what only a server can prove | sharded clusters, failover, access control, a standalone server, a position that has left the oplog window, a transaction that outgrows its limits |
| Live, cross-engine | the above, and `HOBO_TEST_POSTGRES_URL` for the PostgreSQL half | `test/cross-engine-live.test.ts`: SQLite ↔ MongoDB and PostgreSQL ↔ MongoDB through the hub, both directions | |

The live lanes are skipped cleanly without their variables. CI's
`Live data engines` job sets both, against a one-member MongoDB 8 replica set and
a PostgreSQL 16, on pull requests whose diff reaches these suites or on a manual
dispatch. To run them yourself:

```bash
HOBO_TEST_MONGODB_URL='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' \
  pnpm --filter @hobo/data-mongodb exec vitest run test/
```

What only a server proves, and the live lane does: a native in-place update
captured as of its change, from a pre-image the server stored; the validator
refusing a native wrong-type write; a write stalled across `raise` being waited
out; a client with its own connection writing around the fence; a dropped
collection refusing a tenant-scoped reader; a transaction kept whole across
pages; six malformed positions, six different server codes, one answer; and
errors that hold nothing of the document the server quoted. Every binding gets
its own database, dropped on close; the lane fails if one is left behind. The
connection string is read from the environment and never logged, recorded, or
put in a fixture.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
in `data-models/data_mongodb.proto`, the CUE invariants in
`data-models/data_mongodb.cue`, and the pact in
`contracts/pacts/mongo-executor.pact.json`.
