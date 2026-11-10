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
| `float64` | finite JSON number |
| `decimal` | plain decimal string, no leading or trailing zeros (`"1234.56"`) |
| `string` | string |
| `bytes` | standard padded base64 |
| `timestamp` | UTC, exactly six fractional digits (`2026-01-02T03:04:05.678000Z`) |
| `date` | `YYYY-MM-DD` |
| `uuid` | lowercase |
| `json` | any JSON value |
| `encrypted` | `{ alg, keyRef, ciphertext }`, opaque |

Normal form is what makes cross-engine verification possible: `1.50` in one
engine and `1.5` in another must be the same bytes, or a digest comparison
reports a difference that is not there. A value that cannot be represented is
refused, never rounded — a timestamp with nanosecond digits throws, and so does
text containing an unpaired surrogate, which has no UTF-8 encoding and would
otherwise store and digest as U+FFFD in every engine.

`encrypted` values move as ciphertext. No engine, relay, or artifact needs the
key, so destroying the forgetting key erases every copy at once.

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
| `apply` | apply changes and record a watermark in one transaction |
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
nothing. Without it the old side goes stale at the flip, and the executor says
so (`rollback: "to-snapshot"`) rather than claiming otherwise.

### The cutover is decided before it is done

Under the fence, once both sides digest equal, an executor journals
`migration.CutOver` and only then calls `flipAuthority`. A crash between the two
is resumed by finishing the move — `flipAuthority` must be idempotent — never by
re-verifying against a target that has since taken writes, failing, and
releasing the source's fence into two writable stores.

## Selection

`selectMigrationPattern` is a pure function: no clock, no I/O, the same inputs
always producing the same digest. Candidates pass hard gates — the pattern is
legal for the authority and change, both engines have the ports, the composed
type mapping has no un-waived lossy edge, conformance evidence is fresh, the
policy verdict passes, the write freeze fits the budget, the rollback posture
is at least what was required — and survivors are ordered lexicographically:
rollback strength, then write freeze, then native over hub, then custody
points, then cost, then pattern id. Never a weighted score.

There is no silent downgrade. When nothing survives, the decision names a
reason for every pattern in the catalog.

## Policy

A plan carries a **custody path**: every place the data rests or passes —
source, target, staging artifacts, relays, capture logs, rollback snapshots,
the retiring source. `evaluateCustodyPath` computes the verdict from it:

- residency at every point (`evaluateResidency` from `@hobo/core`, fail-closed:
  an unmapped region is a conflict);
- no protection downgrade for the data's classification;
- every bounded copy has a retention deadline, and none has outlived it.

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
- **Events.** Executors emit `migration.*` facts: `Planned`, `PhaseApplied`,
  `Verified`, `CutOver`, `Held`, `Resumed`, `RolledBack`, `Completed`,
  `Failed`. Facts carry positions, counts, and digests — never a record, never
  a credential.
- **Actor.** A migration is an aggregate keyed by its id: a single-writer
  **actor** whose state is `foldMigration` over its facts. The executor is the
  only writer of that stream.
- **Event store.** `createEventStoreMigrationJournal` appends the facts to the
  durable **event store** under optimistic `seq`, one stream per migration
  (`migration:<id>`). A crash is recovered by replaying the stream and
  continuing from the last completed phase.
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
a pooled-to-silo tenant move, and gated in-place evolution. Twenty-one cases;
`ENGINE_CONFORMANCE_CASE_IDS` lists them.

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
- A `native` realization is selected here and executed by the engine package
  that owns the profile; this package runs the `hub` realization.

## Tests

```bash
pnpm --filter @hobo/data-core run build
pnpm --filter @hobo/data-core run test
```

Offline and deterministic. Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the protobuf records
and CUE invariants in `data-models/`, and the two Pact contracts in
`contracts/pacts/`, both replayed against the code by `test/pact.test.ts`.
