# @hobo/data-core

The engine-neutral data contract (ADR-0177): what a dataset and a change look
like in transit, the ports a storage engine implements, the closed catalog of
ways to move live data, how one of them is chosen, how policy is held through
every intermediate state, and the suite that proves an engine.

It imports `@hobo/core` and nothing else. It opens no connection and holds no
state. Engine packages (`@hobo/data-sqlite`, `@hobo/data-postgres`,
`@hobo/data-mongodb`) derive from it; `@hobo/trails` composes its executors
into runbooks and consumes their evidence.

Design: [`docs/design/data-engines-continuous-migration.md`](../../docs/design/data-engines-continuous-migration.md).

## What this package owns

| Concern | Entry point |
|---|---|
| The canonical record model | `parseDatasetSchema`, `parseCanonicalRecord`, `encodeRecordKey` |
| The change envelope (the hub) | `ChangeEnvelope`, `RecordMutation`, `envelopeOf` |
| The engine SPI | `EngineBinding`, `EngineDeclaration`, `parseEngineDeclaration` |
| Type-mapping honesty | `parseTypeMappingAnnex`, `composeTypeMapping` |
| The pattern catalog | `PATTERN_CATALOG`, `patternsFor`, `patternCatalogDigest` |
| Deterministic selection | `selectMigrationPattern` |
| The policy verdict | `parseCustodyPath`, `evaluateCustodyPath` |
| The pattern executors | `runInPlaceEvolve`, `runRebuildAndSwap`, `runOfflineCopy`, `runSnapshotAndTail`, `runLogPivot`, `runStreamHandoff` |
| The migration aggregate | `foldMigration`, `createEventStoreMigrationJournal` |
| The conformance kit | `runEngineConformance`, `foldConformance` |
| The reference engine | `createReferenceEngine`, `withoutPorts` |

## The canonical model

A dataset is a named set of keyed records. Its schema gives each field a
canonical type, and a record is a plain JSON object whose values are in the
**one** normal form that type allows:

| Type | Normal form |
|---|---|
| `bool` | `true` / `false` |
| `int64` | decimal string (`"9007199254740993"`), so no value is lost to a double |
| `float64` | finite JSON number; `-0` becomes `0`; `NaN` and the infinities are refused |
| `decimal` | plain decimal string, no leading or trailing zeros (`"1234.56"`) |
| `string` | string |
| `bytes` | standard padded base64 |
| `timestamp` | UTC, exactly six fractional digits (`2026-01-02T03:04:05.678000Z`); the input must be RFC 3339 with an offset of at most ±23:59 |
| `date` | `YYYY-MM-DD` |
| `uuid` | lowercase |
| `json` | any JSON value; its numbers follow the `float64` rule |
| `encrypted` | exactly `{ alg, keyRef, ciphertext }`, opaque; any other member is refused |

Normal form is what makes cross-engine verification possible: `1.50` in one
engine and `1.5` in another must be the same bytes, or a digest comparison
reports a difference that is not there. A value that cannot be represented is
refused, never rounded — a timestamp with nanosecond digits throws, and so does
text containing an unpaired surrogate, which has no UTF-8 encoding and would
otherwise store and digest as U+FFFD in every engine.

A normal form keeps a value or refuses it. It never returns a value nobody
wrote:

- **Negative zero.** `-0` and `0` encode to the same canonical bytes, so they
  always digested equal, while an engine may store them apart (a document
  store keeps the sign; SQLite's `REAL` and a text-encoded parameter do not).
  `-0` is normalised to `0` at parse, in a `float64` field and inside a `json`
  value, so equal digests mean equal values. `NaN` and the infinities have no
  JSON encoding — they would digest as `null` — and are refused in both places.
- **Timestamp offsets.** The offset is mandatory and bounded as RFC 3339
  bounds it: hours at most 23, minutes at most 59. `+99:99` is refused; it
  used to shift the instant by four days.
- **Encrypted values.** An `encrypted` value has exactly three members. A
  nonce, an authentication tag, or associated data is packed into the
  `ciphertext` bytes by whoever encrypted the value. A fourth member (`iv`,
  `tag`, …) is refused rather than dropped: dropping it left a value nobody
  could decrypt whose digest still agreed on both sides of a move. The refusal
  names no member and no value, since either may be key material.

`encrypted` values move as ciphertext. No engine, relay, or artifact needs the
key, so destroying the forgetting key erases every copy at once.

`instantMicros` is the one reader of instant text for every gate that compares
instants (a retention deadline, the age of conformance evidence). It accepts
what a `timestamp` accepts, answers microseconds since the epoch, and answers
`undefined` for anything else — including an instant with no offset, which
`Date.parse` would read as local time and so differently on every host.

## The engine SPI

Nine ports. `datasets` and `records` are mandatory; the rest are optional, and
**absence is a declaration**: a port an engine cannot provide makes the
patterns that need it ineligible, by name.

| Port | Contract |
|---|---|
| `datasets` | create a dataset from a canonical schema, idempotently; describe it |
| `records` | the single write entry point, and point reads |
| `snapshot` | scan a scope in chunks (may be fuzzy — see below) |
| `capture` | ordered changes after a position; durable, resumable, non-consuming |
| `apply` | apply changes and record a watermark in one transaction; with `expectedWatermark`, only if the recorded watermark is the one named |
| `verify` | counts and digests for a scope — never a record |
| `fence` | raise a write fence with a token; a fenced writer is refused |
| `retire` | destructive removal; refused without the fence token and a matching digest |
| `schema` | expand / backfill / contract statements, with snapshot and restore |

Every method may answer synchronously or asynchronously (`Awaitable`).

A binding's declaration states the real limits of its engine: `captureOrdering`,
`fenceEnforcement` (`store` or `entry-point`), `snapshotConsistency`,
`ddlTransactional`, its type-mapping annex, and its impedance codes.
`assertBindingMatchesDeclaration` refuses a binding that provides a port it
does not declare, or declares one it does not provide.

**A conditional apply.** `ApplyRequest.expectedWatermark` names the watermark
the applier believes is recorded for its `source` — `null` for none yet. The
engine compares and writes in one transaction; when the watermark is anything
else it refuses the whole batch with `StaleApplyError` (`STALE_APPLY`) and
nothing lands. Of two appliers naming the same watermark, exactly one lands.
Absent, an apply is unconditional, as before. The executors use it for every
batch they apply: it is how a driver that has been superseded is kept from
writing over the one that superseded it.

### The native-transfer port

An engine that declares a native migration profile (`nativeProfiles`) also
provides `nativeTransfer`: the engine's own bulk transport, for a `native`
realization. The port replaces exactly two things the hub does — the seed and
the tail — and nothing else.

| Method | Asked of | Contract |
|---|---|---|
| `publish` | source | start retaining every change to the scope for a named transfer; answer a ticket. Idempotent |
| `subscribe` | target | begin the engine's own copy of what was published. Idempotent. Refused, never approximated, when the engine cannot copy the scope faithfully |
| `seeded` | target | true once the initial copy is complete |
| `mark` | source | a position every change committed so far sits at or before |
| `reached` | source | true once the target has durably applied everything up to a mark |
| `stop` | either | drop what this side holds, and the log it pinned. Idempotent |

The ticket is journaled, so nothing that crosses the port may carry a
credential or a record. How the target reaches the source — a connection
string, a network path — is given to the binding when it is constructed.
`seeded` and `reached` may wait a bounded time inside the engine before
answering false; an executor polls a bounded number of times and never sleeps.

The declaration and the port are held to each other profile by profile:
`assertBindingMatchesDeclaration` refuses a declared profile the port does not
run, and a port that runs a profile nobody declared. A declared fast path with
nothing behind it is how a decision comes to say `native` while nothing can
execute it.

The reference engine opts in with `createReferenceEngine({ native: link })`,
where `createReferenceNativeLink()` stands in for the connection two real
stores would be given.

`createReferenceEngine()` is the executable definition of what each port
means. When the prose and that file disagree, the file is right.

### Why a scan may be fuzzy

An executor takes a capture position **before** it opens a snapshot and replays
from that position afterwards. Every change the scan could have missed or seen
half-applied is re-applied in order, so the copy converges whether or not the
engine can give a consistent snapshot. No engine is required to.

## The pattern catalog

Two questions pick a pattern: who is the authority, and what changes.

| | Shape | Placement | Engine | Paradigm |
|---|---|---|---|---|
| **Projected** (the event log is the truth) | `rebuild-and-swap`, `in-place-evolve` | `rebuild-and-swap` | `rebuild-and-swap` | `rebuild-and-swap` |
| **Authoritative** (the store is the truth) | `in-place-evolve` | `snapshot-and-tail`, `offline-copy` | `snapshot-and-tail`, `offline-copy`, `log-pivot` | `log-pivot` |
| **Journal** (the event store itself) | — | `stream-handoff` | `stream-handoff` | — |

| Pattern | Writes refused | Rollback in the soak window |
|---|---|---|
| `in-place-evolve` | never | to the pre-migration snapshot |
| `rebuild-and-swap` | never | lossless — the old sink stays valid |
| `offline-copy` | for the whole copy | lossless with a reverse tail, else to-snapshot |
| `snapshot-and-tail` | only for the fence-and-flip step | lossless with a reverse tail, else to-snapshot |
| `log-pivot` | only for the fence-and-flip step | none — authority has moved into the log |
| `stream-handoff` | only for the fence-and-flip step | to-snapshot |

Every pattern keeps **exactly one write authority at any log position**. The
second store is fed by capture and authority changes hands once, under a fence
token. Application-level dual-write is deliberately not in the catalog.

A *reverse tail* is capture on the target plus apply on the source: after the
flip the old side keeps receiving the new side's writes, so a rollback loses
nothing — **provided the target can be fenced** while authority goes back.
Without that fence the target can acknowledge a write between the rollback's
last digest and the flip, and that write is gone. So `lossless` needs three
ports: `apply` on the source, `capture` *and* `fence` on the target
(`reverseTailPorts` in the catalog). Lacking any of them the old side is not
provably current, and the executor, the catalog and the selector all say so
(`rollback: "to-snapshot"`) rather than claiming otherwise.

### Two ways for records to travel

`runSnapshotAndTail` and `runOfflineCopy` take the realization the selector
chose: `realization: "hub"` (the default) moves canonical records through the
ports; `realization: "native"`, with the `profile` to run, hands the seed and
the tail to the engine's `nativeTransfer` port. Either way this package keeps
every phase, the policy verdict in front of each, the digests through
`verify`, the fence, the cutover decision and the flip, the soak, and the
journal. `migration.Planned` records the realization and, for native, the
profile; a native transfer is closed after the cutover is journaled and before
write authority moves, and again before the source is retired.

### Decide, record, then act

Whatever moves or releases write authority has a journaled fact in front of
it, and every fact is a compare-and-set on the journal head the run read:

| Before | the run journals |
|---|---|
| a write fence is raised (source at the cutover, target at a rollback) | `migration.FenceRequested` |
| a fence is released because verification under it failed | `migration.Held`, with `compensated: true` |
| authority moves to the target | `migration.CutOver` |
| authority moves back to the source | `migration.RollbackDecided` |

A crash between a fact and its side effect is resumed by *finishing* what the
fact says — `flipAuthority` must be idempotent — never by re-verifying against
a store that has since taken writes, failing, and releasing a fence into two
writable stores. A journaled rollback is finished by whichever run comes next
and `soakDecision` is not asked again; a crash after the source's `retire`
committed finds the scope empty behind the migration's own fence and completes.
At every point either exactly one side is writable, or the run is in a hold a
later run can leave.

### One driver

`MigrationJournal.append(migrationId, fact, expectedCount)` appends only when
the journal holds exactly `expectedCount` facts, and throws
`JournalConflictError` (`JOURNAL_CONFLICT`) otherwise. The memory journal
checks its own length; the event-store journal passes the count as the
stream's `expectedSeq` and never re-reads the head. A run tracks the count it
loaded plus what it appended.

So of two drivers of one migration, the one whose view is out of date loses
its next fact — and because that fact comes *before* the side effect, it stops
without touching either store: no fence raised, none released, no flip. Where
its next step is an apply rather than a fact, the store refuses it: every
batch is conditional on the leg's watermark, the watermark carries the journal
head of the driver that wrote it (`<head>@<position>`), and under the fence the
cutting-over driver stamps its own head on the leg before anything is compared.
A driver that meets either refusal (`isSupersededError`) records nothing,
compensates nothing, and rethrows it.

What this does not close: a driver that wins a fact and then stalls *between*
that fact and the side effect it authorizes, while a third run finishes the
step and moves on, still performs that one side effect late. `flipAuthority`
and `fence.release` are the caller's and the engine's; they take no head to be
refused by. Run one driver per migration; this is the safety net, not a lease.

## Selection

`selectMigrationPattern` is a pure function: no clock, no I/O, the same inputs
always producing the same digest. Candidates pass hard gates — the pattern is
legal for the authority and change, both engines have the ports, the composed
type mapping has no un-waived lossy edge, conformance evidence is fresh, the
policy verdict passes and covers what the pattern creates, the write freeze
fits the budget, the rollback posture is at least what was required — and
survivors are ordered lexicographically: rollback strength, then write freeze,
then native over hub, then custody points, then cost, then pattern id. Never a
weighted score.

There is no silent downgrade. When nothing survives, the decision names a
reason for every pattern in the catalog.

Every gate fails closed on input it cannot read:

| Input | Rule | Otherwise |
|---|---|---|
| `now` | RFC 3339 with an explicit offset | `INVALID_SELECTION_REQUEST` |
| `constraints.maxWriteFreezeMs`, `evidenceMaxAgeMs` | a finite number, zero or more | `INVALID_SELECTION_REQUEST` |
| `estimates.flipMs`, `estimates.copyMs` | a finite number, zero or more; `NaN`, an infinity or a negative is no estimate | `FREEZE_UNESTIMATED` |
| `evidence[].checkedAt` | RFC 3339 with an explicit offset | `EVIDENCE_STALE` |
| `evidence[].checkedAt` | not after `now` | `EVIDENCE_POSTDATED` |
| `verdict.roles` | names every custody role the candidate creates | `CUSTODY_INCOMPLETE` |

**Evidence.** An engine may have several entries, and all of them are read.
The one that counts is the most recent; when several share that instant, the
worst of them (`fail`, then `unknown`, then `pass`). So `[pass, fail]` and
`[fail, pass]` are the same evidence, and a later pass — the engine fixed and
re-run — supersedes an earlier failure. An entry the gate cannot place in time
(an unreadable `checkedAt`, or one after `now`) fails its engine whatever else
is listed: it cannot be shown to be older than a passing run.

**Custody coverage.** A verdict judges the places its path named and no
others; `verdict.roles` lists them. A candidate whose pattern creates a role
the path left out is rejected with `CUSTODY_INCOMPLETE`, naming the roles —
see [Policy](#policy) for which pattern creates what. The check uses the
candidate's own realization and reverse tail, so a native candidate is not
asked for a relay and a copy with no reverse tail is not asked for the
target's change log.

## Policy

A plan carries a **custody path**: every place the data rests or passes —
source, target, staging artifacts, relays, capture logs, rollback snapshots,
the retiring source. `evaluateCustodyPath` computes the verdict from it:

- residency at every point (`evaluateResidency` from `@hobo/core`, fail-closed:
  an unmapped region is a conflict);
- no protection downgrade for the data's classification;
- every bounded copy has a retention deadline, and none has outlived it;
- the path names every role its migration creates.

**Instants.** `retainUntil` and `now` are RFC 3339 with an explicit offset,
read by `instantMicros` and compared to the microsecond. An instant with no
offset is malformed: `parseCustodyPath` and `evaluateCustodyPath` throw
`INVALID_CUSTODY_PATH`. A deadline equal to `now` has passed.

**A path must be complete for its pattern.** A pattern creates copies beyond
its two ends, and a path that leaves one out was never judged there.
`requiredCustodyRoles` derives what each pattern creates from the catalog —
the ports a pattern drives are the places it puts data:

| Role | Created when | Patterns (hub) |
|---|---|---|
| `source` | the pattern drives source ports | all but `rebuild-and-swap`, `stream-handoff` |
| `target` | the pattern drives target ports | `rebuild-and-swap`, `offline-copy`, `snapshot-and-tail`, `log-pivot` |
| `event-log` | it drives no source port (the log is what it reads), or authority moves into the log | `rebuild-and-swap`, `log-pivot`, `stream-handoff` |
| `relay` | the hub realization carries every record through the runner — unless one store is changed where it stands | all but `in-place-evolve`; never for `native` |
| `capture-log` | the source's `capture` port; a reverse tail (the target's log); a `native` transfer, which retains the log itself | `snapshot-and-tail`, `log-pivot`; `offline-copy` with a reverse tail or `native` |
| `rollback-snapshot` | the source's `schema` port snapshots before any change | `in-place-evolve` |
| `retiring-source` | the source's `retire` port | `offline-copy`, `snapshot-and-tail` |

A `staging-artifact` is never implied; a plan that writes one names it.

Two things enforce the table:

- `evaluateCustodyPath({ path, policy, now, migration })` — given the
  migration (`pattern`, and optionally `realization` and `reverseTail`), each
  missing role is a `CUSTODY_PATH_INCOMPLETE` finding and the verdict is
  negative. An unstated `realization` or `reverseTail` takes the more
  demanding reading.
- The verdict always carries `roles`, the roles its path named. Without a
  `migration` the verdict is for the path as declared and no more, and the
  selector refuses every candidate that creates a role outside `roles`
  (`uncoveredCustodyRoles`). A path of only `{ source, target }` can be `ok`
  as a path; it selects no pattern.

Executors recompute the verdict before **every** phase. A negative verdict
holds the migration at its last safe state and records why; nothing in the
phase runs. Only the fence-and-flip step is not a safe hold — it completes or
compensates.

## Parse, don't validate

Untrusted input crosses one parser and becomes a derived domain type that the
rest of the package accepts as-is.

| Raw input | Parser | Derived type | Impossible afterwards |
|---|---|---|---|
| a schema document | `parseDatasetSchema` | `DatasetSchema` | a nullable key, a float key, a non-portable name |
| a record | `parseCanonicalRecord` | `CanonicalRecord` | two spellings of one value; an out-of-range int64 |
| an envelope | `parseChangeEnvelope` | `ChangeEnvelope` | an upsert with no record, a delete with one |
| an engine declaration | `parseEngineDeclaration` | `EngineDeclaration` | a capture ordering without a capture port |
| a custody path | `parseCustodyPath` | `CustodyPath` | a duplicate point, an unknown role or protection |
| a type-mapping annex | `parseTypeMappingAnnex` | `TypeMappingAnnex` | a non-exact edge with no explanation |

The protobuf records in [`data-models/data_core.proto`](./data-models/data_core.proto)
are the wire projection of these parsed types, and
[`data_core.cue`](./data-models/data_core.cue) carries the same invariants.
`test/cue-constraints.test.ts` vets real parser output against the CUE, so the
two cannot drift apart unnoticed.

## Event architecture

- **Commands.** Running, resuming, holding, and rolling back a migration are
  the commands; an executor is what handles them. A command names a migration
  id, and re-running a completed migration is a no-op rather than a second
  cutover.
- **Events.** Executors emit `migration.*` facts: `Planned`, `SnapshotTaken`,
  `PhaseApplied`, `Verified`, `FenceRequested`, `CutOver`, `Held`, `Resumed`,
  `RollbackDecided`, `RolledBack`, `Completed`, `Failed`. Facts carry
  positions, counts, and digests — never a record, never a credential, and
  never a thrown message: a failure is the error's class name, plus its code
  when the error is this package's own. The bodies are pinned in
  `@hobo/events` (`MIGRATION_EVENT_CONTRACTS`); `MIGRATION_FACT_VERSIONS` is
  the version each is journaled at, and a test in `@hobo/events` runs every
  executor and holds each emitted fact to its contract.
- **Actor.** A migration is an aggregate keyed by its id: a single-writer
  **actor** whose state is `foldMigration` over its facts. The executor is the
  only writer of that stream.
- **Event store.** `createEventStoreMigrationJournal` appends the facts to the
  durable **event store** under optimistic `seq`, one stream per migration
  (`migration:<id>`): the append is conditional on the head the run read. A
  crash is recovered by replaying the stream and continuing from the last
  completed phase. `completed` and `rolled-back` are absorbing in the fold — a
  fact appended after either reopens nothing.
- **Projections / materialized views.** Migration status — which phase, held
  why, what rollback remains — is a **projection** over those facts.
  `rebuild-and-swap` and `log-pivot` are themselves the machinery that builds
  an application's **materialized views** in a new sink by replaying the log.
- **Snapshots / read store.** Each `PhaseApplied` fact carries the phase's
  checkpoint, which is the aggregate's **snapshot** for resume. The sinks the
  projection patterns write are the application's **read store**; they are
  derived, and can always be rebuilt from the log.

The change envelope is deliberately **not** an event. Payload in the log would
make the log a custody point for data in flight, so envelopes pass between a
capture port and an apply port and are never appended. `log-pivot` is the one
named exception: moving authority into the log is its purpose.

## Conformance

```ts
import { runEngineConformance } from "@hobo/data-core";

const report = await runEngineConformance({
	engine: { create: () => createMyEngine() },
	now: clock(),
});
// report.outcome: "pass" | "fail" | "unknown"
```

The suite proves the ports, then the patterns built on them: zero loss under
load, a single write authority, resume after a crash at every phase boundary,
a lossless soak rollback, a rollback that cannot resurrect an erased subject,
a pooled-to-silo tenant move, and gated in-place evolution. Thirty cases;
`ENGINE_CONFORMANCE_CASE_IDS` lists them. `apply.stale-watermark-is-refused`
is the conditional apply: a batch that names a watermark the store has moved
past is refused with `StaleApplyError`, changes neither a record nor the
watermark, and of two appliers naming the same watermark exactly one lands.

Six of them are probes for defects found in one engine and worth holding every
engine to: a first-century timestamp round-trips or is refused when written
(never accepted and then unreadable); an undeclared open-schema field named
`__proto__` survives; a write whose key disagrees with its record's key is
refused; a dataset named after an engine's own bookkeeping is refused or
harmless; capture survives an update of a record with a very large key; and
reading capture from a position the engine never minted is an error, not an
empty caught-up batch.

Two more prove a `native` realization (`NATIVE_CONFORMANCE_CASE_IDS`): zero
loss with writers running during the engine's own copy and racing the fence,
and resume after a crash at every phase boundary. They run only when engine
and peer declare a shared native profile for the pattern, and are reported as
skipped otherwise. An engine whose two sides must be placed specially — the
same schema name in two databases, the target told how to reach the source —
supplies `createNativePair` on its harness.

The fold is pessimistic. A failure is `fail`; a case that applies but could not
run is `not-run`, which makes the outcome `unknown`; and `unknown` is as
non-selectable as `fail`. A case whose port the engine does not declare is
skipped — which is not forgiveness: the pattern needing that port is then
ineligible at selection.

Pass `peer` to prove a cross-engine move: the engine under test is the source
and the peer is the target.

## Honest limits

- There is no transaction across source and target. Convergence is bounded lag
  plus a fence; the flip is brief, not instantaneous.
- The hub carries canonical records. Sequences, triggers, stored procedures,
  and engine-specific index types do not cross it.
- `stream-handoff` runs over the event-store port, which has no
  identity-preserving import. A handed-off event keeps its stream, sequence,
  type, version, payload, actor, and tenant; its id and timestamp are minted
  by the target store and the originals travel in `meta.handoff`. Every
  handoff reports `HANDOFF_EVENT_IDENTITY_REMINTED`.
- `log-pivot` compares digests only when the sink keeps the source's schema.
  A genuine re-model changes the records, and the evidence is then positional.
  When the schema *is* kept, the store being adopted must provide `verify`:
  the run is refused (`PORT_MISSING`) rather than verified against nothing,
  and `migration.Verified` says `compared: true` only after a comparison.
- A `native` realization carries no reverse tail. The engine's transport is
  dropped at the cutover, so the old side goes stale there and a rollback from
  soak is `to-snapshot`; the selector ranks a hub run with a reverse tail above
  it for exactly that reason.
- A `native` realization that cannot run is an error
  (`NATIVE_REALIZATION_UNAVAILABLE`, or the engine's `NATIVE_TRANSFER_REFUSED`),
  never a quiet hub run. A run planned one way cannot be resumed the other.
- A failed native run leaves its transfer in place, because that is what lets
  it be resumed. Abandoning it instead takes one `nativeTransfer.stop` on each
  side, under `nativeTransferName(migrationId)`.
- The journal records a digest of the fence token, never the token. A later
  phase, or a resumed run, gets the token back by raising the fence again —
  raising a raised fence answers its token — and holds if the digest no longer
  matches. It asks `fence.status` first and "raises" only a fence that is up:
  one that is down was lifted behind the migration's back, and the run holds
  for a person instead of putting a fresh fence on a store that may be the
  authority. An engine whose fence does not survive a restart therefore
  cannot resume a cutover.
- A `to-snapshot` rollback needs the `erasures` ledger, and
  `in-place-evolve` needs `replayErasures` to restore. Without one the run
  holds: no ledger is not the same as no erasures. The ledger is asked from
  the instant the source's fence was first requested (`CutOver.fencedFrom`),
  not from the cutover — an erasure that arrives while the source is fenced is
  dated before the cutover and never reached the source.
- A policy verdict must cover the run. Before every phase the run checks the
  verdict's `roles` against the custody roles its pattern, realization and
  reverse tail create (`uncoveredCustodyRoles`), and holds — recorded as
  `migration.Held`, `CUSTODY_PATH_INCOMPLETE` — when a relay, a retained log or
  the retiring source was never on the path.
- `in-place-evolve` is resumable only with a `journal`. With one, phases that
  have a `PhaseApplied` fact are skipped and a failure restores the first
  snapshot. A phase's fact follows the phase, so a crash between the two
  re-applies that phase on resume; if its statements are not repeatable the
  phase fails and the run restores the snapshot. The restore itself is decided
  first (`RollbackDecided`), and is finished by the next run.
- An `offline-copy` whose verification fails releases the fence and holds; the
  next attempt copies again but only upserts, so records deleted on the source
  in between stay on the target and the comparison fails again until they are
  removed.

## Tests

```bash
pnpm --filter @hobo/data-core run build
pnpm --filter @hobo/data-core run test
```

Offline and deterministic. Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
and CUE invariants in `data-models/`, and the two Pact contracts in
`contracts/pacts/`, both replayed against the code by `test/pact.test.ts`.
