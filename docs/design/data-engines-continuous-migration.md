---
type: Reference
title: "Data Engine Packages & Continuous Data Migration"
description: "The data engine package family (a common engine-neutral contract plus one package per engine) and the continuous-migration pattern catalog, deterministic pattern selection, and continuous policy gate that let data move between products, engines, and paradigms — with what is implemented, how it is proven, and what is not."
tags: [hobo, design, data-plane, migration, architecture]
---

# Data Engine Packages & Continuous Data Migration

Decision record: [ADR-0177](./adr/03-data-plane.md#adr-0177). This note is the design behind it: *what
the units are*, *what an engine must implement*, *which migration patterns exist and when each is
legal*, *how policy holds for every intermediate state*, and — because this is implemented, not
proposed — *what proves each claim and what is still not true*. It extends
[data-plane.md §Migrations](./data-plane.md#migrations--cross-cloud-portability)
([ADR-0032](./adr/03-data-plane.md#adr-0032)) and the Trails engine
([ADR-0134](./adr/02-identity-security.md#adr-0134)); it replaces neither.

The code is the authority. Where this note names a test file, the claim beside it rests on that
file; where it names none, the claim is a description of the source, not a proof.

## 1. What was wrong, and what changed

Most of the concepts already existed — expand/backfill/contract, snapshots, CDC duals, migration
profiles, the residency evaluator, the Trail runner. What was missing was the seam between them.

| Finding before | What changed |
|---|---|
| Engine code lived inside the orchestrator: `@hobo/trails` imported `node:sqlite` for its schema-apply and dual-run ports, so a second engine would have been added *to the runbook engine* | The SQLite bindings moved to `@hobo/data-sqlite`. `@hobo/trails` keeps port shapes only. The package-boundary gate refuses, from an orchestrator's `src/`, any import of a `@hobo/data-<engine>` package, a database driver (`node:sqlite`, `pg`, `mongodb`, …), or engine-specific storage — static, dynamic, or `require` — and refuses one engine importing another. Test-only edges are allowed |
| No shared engine contract: `@hobo/data-postgres` owned a profile, a conformance suite, and migration profiles, but implemented none of the ports Trails executes | `@hobo/data-core` defines one SPI. SQLite, PostgreSQL, and MongoDB implement it and are run against one conformance kit (§9 says which cases each passes and which it skips) |
| The migration pattern was an untyped mode string (`"bulk" \| "delta" \| "cdc-dual"`) with no record of why it was chosen | A closed pattern catalog and a pure selector whose decision — every candidate, every reason — is a digested record |
| Policy inputs were asserted: `CanTrailInput.residencyConflict?: boolean`, `policyAllows?: boolean` | A verdict computed over a custody path — every place the data rests or passes — and recomputed before every phase. `can-trail` takes it alongside the booleans: any one of them denying denies the trail, and a malformed verdict is a denial. The booleans are still caller-asserted (§8) |
| Verification moved rows into the control plane (`DataDualView.sourceRows`) | A `verify` port that returns counts and digests. The Trails oracle judges a live store on digest evidence when its port provides `evidence()`; a port without it still falls back to comparing snapshot rows |
| Engine and product shared one closed enum (`DataStoreProvider`) | `@hobo/core` gains `DataStoreEngine` and `engineOfDataStoreProvider`; a product that hosts several engines is `other`, not guessed |

## 2. Three grains, three audiences

"Postgres", "SQL", and "MongoDB" are not the same kind of thing, and the package family does not
pretend they are. The capability refinement graph
([ADR-0151](./adr/07-portability-extensibility.md#adr-0151), `@hobo/manifest-capability`) already
separates the grains; packages follow it.

| Grain | Example | Profile node | Package family | Audience |
|---|---|---|---|---|
| **Paradigm** | relational, document, key-value, graph, vector | `data.relational/v1`, `data.document/v1` | `@hobo/data` (portable default) and the opt-in idiom layers of [ADR-0081](./adr/03-data-plane.md#adr-0081) | app authors |
| **Engine** | PostgreSQL, SQLite, MongoDB, MySQL, SQL Server | `data.postgres/v1`, `data.sqlite/v1`, `data.mongodb/v1` | **`@hobo/data-<engine>`**, derived from **`@hobo/data-core`** | engine/platform authors |
| **Product** | Neon, RDS, Cloud SQL, Atlas, D1 | declares which engine profile it implements, with evidence | `@hobo/provider-<product>` | provider authors |

**The engine is the right grain for migration mechanics.** A wire protocol, a type system, DDL
semantics, a replication mechanism, and a dump format are properties of the engine. Every product of
that engine shares them; no two engines do. A product only narrows the set (a serverless endpoint that
speaks Postgres but cannot open a replication slot), and that narrowing is a declaration-side fact:
the PostgreSQL and MongoDB bindings can each be constructed without the capture port, with a
declaration that says so.

"SQL" is therefore not a package. It is the relational *paradigm*; its engines are separate packages
because their dialects, types, and replication are not substitutable.

## 3. Package topology

```
@hobo/core                 ports adapters implement: SchemaIr + diff, jurisdiction, EventStore; engine-vs-product vocabulary
@hobo/data                 app-facing CQRS kernel: command / projection / repo / view (unchanged)

@hobo/data-core            the engine-neutral contract every engine package derives from
  ├─ canonical model       dataset schema, canonical records, the change envelope
  ├─ engine SPI            the nine declared ports in §4, the optional native-transfer port, and the engine declaration
  ├─ type-mapping annex    per-engine fidelity, composed across engines
  ├─ pattern catalog       the six continuous-migration patterns in §5
  ├─ pattern selector      pure, deterministic: hard gates then lexicographic order (§7)
  ├─ policy verdict        custody path → computed residency / protection / retention / coverage verdict (§8)
  ├─ pattern executors     the six patterns, run over the ports, journal-driven, policy-gated per phase
  ├─ migration aggregate   migration.* facts, their fold, a compare-and-set journal over the event store
  ├─ conformance kit       the one suite every engine is run against (§9)
  └─ reference engine      in-memory, complete: the executable definition of each port

@hobo/data-sqlite          SQLite over node:sqlite — and the sync ports Trails' live lanes run on
@hobo/data-postgres        PostgreSQL over an injected executor; logical-decoding capture; native logical-copy; no driver dependency
@hobo/data-mongodb         MongoDB over an injected executor; change-stream capture; no driver dependency

@hobo/trails               the runbook engine: composes migrations into Trails, gates them, imports no engine
@hobo/provider-*           products: declare an engine profile + evidence; contain no engine logic
```

**Why the common package is `@hobo/data-core` and not `@hobo/data` itself.** `@hobo/data` is the
app-authoring namespace in the import-ownership map ([package-namespaces](./package-namespaces.md),
ADR-0087), and it depends on `@hobo/storage-sqlite` for the durable actor host. Putting the engine
contract there would give app authors and engine authors one import site, make every engine package
depend transitively on one particular engine, and put three compatibility regimes on one version
line. `-core` is the conventional name for the base a family derives from. It imports `@hobo/core`
and nothing else, and classifies as a layer-1 `contract` package in the boundary gate, which is what
lets every engine package import it.

**Where the executors live.** In `@hobo/data-core`, not in `@hobo/trails`. A pattern executor is
engine-neutral orchestration over the SPI — it does no I/O of its own — and it has to be reachable by
the conformance kit, which proves an engine by running the patterns against it. `@hobo/trails`
composes those executors into versioned runbooks, owns history, the progressive ramp, and the
`can-trail` gate, and consumes the executors' evidence. Its public surface stays sealed: it mirrors
port shapes structurally and re-exports no foreign type.

**One implementation of expand → backfill → contract.** `executeDataMigration` in `@hobo/trails`
delegates to `runInPlaceEvolve` in `@hobo/data-core`. Neither a successful nor a failing run is the
original executor's fact sequence any more: every phase is preceded by `migration.PhaseIntended`
(`packages/data-core/test/migration-run.test.ts`), a restore has its decision journaled first, and
without an erasure replay it does not restore at all (§8).

**What "resumable" means.** Nothing resumes by itself; a caller runs the executor again with the same
migration id and the same journal, and the executor continues from what the journal records.

- The five executors built on the shared run loop (`snapshot-and-tail`, `offline-copy`,
  `rebuild-and-swap`, `log-pivot`, `stream-handoff`) skip every phase that has a
  `migration.PhaseApplied` fact and hand back its recorded checkpoint. A phase that was interrupted
  has no such fact and runs again from its start; §6 says what each crash window resumes to.
- `in-place-evolve` resumes **only when given a journal** (`runInPlaceEvolve({ journal })`, which
  `executeDataMigration` passes through). It then skips the phases already applied and restores, on
  failure, the first snapshot taken. Without a journal every call is a fresh run that remembers
  nothing, and re-running a held migration that way applies `expand` a second time
  (`packages/data-core/test/in-place-resume.test.ts`).
- **In-place phases are write-ahead.** `migration.PhaseIntended` is journaled, as a compare-and-set,
  before a phase's statements run, and `migration.PhaseApplied` after. A run that finds an intent
  with no answer — the process died between the statements and their fact — does not know whether
  they committed, and the store has been taking writes since. It neither runs them again on a guess
  nor restores the snapshot on their account. It asks the plan's **probe** for that phase
  (`InPlaceEvolvePlan.probes`, `DataMigrationPlan.probes` in Trails): a violations query, run through
  the port's `verify`, that returns no rows exactly when the phase is in effect.
  - No rows: the phase is recorded as applied with `recovered: true` and is not run again.
  - Rows: it is applied under a fresh intent (`retry: true`). If that fails the run holds with
    `PHASE_REAPPLY_FAILED`; nothing is restored.
  - No probe, or one that could not be asked: the run holds with `PHASE_OUTCOME_UNKNOWN` until the
    plan is given one. A caller who knows the statements are safe to run twice says so with a probe
    that always returns a row.

  A throw from `applyPhase` on a first attempt is taken as the port's answer that the phase is not in
  effect, and is answered by the restore (or a hold recording `failedPhase`) — unless a probe says the
  phase *is* in effect, in which case the answer was lost, not the phase. Tests:
  `packages/data-core/test/in-place-resume.test.ts`.
- **A journal written by an earlier release is lifted before it is folded.** `MigrationRun.open`,
  `runInPlaceEvolve`, and the event-store journal's `load` pass what they read through
  `liftMigrationFacts`: a v1 plan keeps its pattern (an in-place plan, which named none, is read as
  `in-place-evolve`), so a resume under another pattern is refused, and a fence token in a v1
  `migration.CutOver` or checkpoint is replaced by its digest before anything folds it
  (`packages/data-core/test/second-review.test.ts`, over a journal recorded from the `65a46a72`
  executors). The stored events are not rewritten.

## 4. The engine contract

An engine package ships: a binding that implements the SPI; a declaration that states the engine's
real limits; a type-mapping annex; a closed list of impedance codes
([ADR-0144](./adr/07-portability-extensibility.md#adr-0144)); and a conformance report.

| Port | Contract |
|---|---|
| `datasets` | create a dataset from a canonical schema, idempotently and additively; describe it |
| `records` | the single write entry point (atomic, fence-aware), and point reads. A mutation's key is the canonical key of its record: a key that disagrees with its record is refused, a non-canonical spelling is refused (or, for an upsert, stored under the canonical key), and a delete naming a non-canonical key is refused. A record larger than the declared `maxRecordBytes` refuses its whole batch |
| `snapshot` | scan a scope in chunks; may be fuzzy |
| `capture` | ordered changes strictly after a position; durable, resumable, non-consuming; `start` is idempotent **for the scope the name was started on** and returns the original position — a subscription name is bound to one scope, and naming it on another dataset or tenant is refused rather than answered with the other scope's position; a batch never splits a source transaction and may exceed its limit to keep one whole; a position the engine never minted, one past its head, or one below what was acknowledged is `CAPTURE_POSITION_INVALID`, never an empty batch and never accepted as an acknowledgement |
| `apply` | apply changes and record the watermark in one transaction; idempotent under redelivery; refused into a fenced scope without the fence's token, like any write. With `expectedWatermark` the apply is **conditional**: the batch lands only if the watermark recorded for its source is exactly the one named (`null` meaning none yet), the comparison and the write are one transaction, and anything else is refused with `StaleApplyError` (`STALE_APPLY`) with neither a record nor the watermark changed. Without the member the apply is unconditional |
| `verify` | counts and bucketed digests for a scope — a record never crosses this port |
| `fence` | raise a write fence and get its token; a fenced writer is refused unless it presents that fence's token — a dataset-wide fence covers every tenant, and the token of another fence or of one since released opens nothing; `release` needs the token; `raise` returns only once no write that began before it can still land. **`raise` on a raised fence returns the existing token** — see below for what that makes the token |
| `retire` | destructive removal; refused without the token of the fence raised on exactly this scope and a still-matching digest. **A redelivered `retire` is harmless in every engine**: retiring a scope that is already empty behind that fence's token removes nothing and succeeds (kit case `retire.redelivery-is-harmless`). What it removed is not replayed to a capture subscription started afterwards |
| `schema` | expand / backfill / contract statements, a restorable snapshot, a violations query |
| `nativeTransfer` | the engine's own bulk transport for a declared native profile: `publish`, `mark`, `reached` on the source; `subscribe`, `seeded`, `pause`, `resume` on the target; `stop` on each. It replaces only seed and converge. `pause` stops delivery — no further change and no further part of an initial copy reaches the target until `resume` — and is what an executor calls when a migration holds (§6) |

`datasets` and `records` are mandatory. For the rest, **absence is a declaration**: a port an engine
cannot provide makes the patterns that need it ineligible in §7, by name.
`assertBindingMatchesDeclaration` refuses a binding that provides a port it does not declare or
declares one it does not provide, and the same in both directions for native profiles.

A declaration may also state `maxRecordBytes`: the largest record the engine stores, in bytes of its
canonical encoding. Absent means the engine states no bound, not that it has none; the kit runs its
size case only against an engine that states one. MongoDB states 16 MiB. SQLite and PostgreSQL state
none.

Two refusals that used to be engine-local are shared: `CAPTURE_POSITION_INVALID`
(`CapturePositionError`, raised by SQLite and PostgreSQL as well as the reference engine) and
`CAPTURE_SUBSCRIPTION_CONFLICT` (SQLite, PostgreSQL, and the reference engine; MongoDB refuses the
same thing under its own `MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT`). A caller that matched
`SqliteDataError` or `PostgresDataError` for a refused position no longer matches it.

**What a fence token is, and is not.** A token names one *generation* of a fence: it is minted when
the fence is raised, and a fence that is released and raised again has a different one (all three
engines mint it from a random UUID; a token derived from the scope and the clock would repeat). It is
a capability held against callers who can **write but cannot raise**: they are refused without it.
It is **not** a secret from anyone who can call `raise`: raising a raised fence answers its token, by
contract, because that is how a resumed run gets the token back without it ever being journaled (§6).
So the token protects only where calling `raise` is itself restricted, and an engine has to keep it
readable in its own metadata to answer that call. PostgreSQL keeps it in a metadata table revoked
from `PUBLIC` and read by a `SECURITY DEFINER` trigger; SQLite and MongoDB keep it in the store's own
bookkeeping, which anything that can open the store can read.

What the three engines declare:

| | SQLite | PostgreSQL | MongoDB |
|---|---|---|---|
| Change capture | transactional outbox, journaled with the write | logical decoding (`pgoutput`) through a replication slot | change streams over a collection with change images enabled (needs a replica set) |
| Capture log retention | a journal row is kept only while some subscription has yet to acknowledge it; with no subscription the journal is empty; `retire` deletes the scope's journal rows with its records | the slot pins write-ahead log until it is acknowledged or stopped | none of its own — the oplog window. `acknowledge` releases nothing, records nothing, and checks nothing, so a read from before an acknowledged position still succeeds: a declared limit (`MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING`), reported as such by the kit (§9) |
| Capture ordering | global | global, in commit order | global |
| Fence enforcement | `entry-point` — stops writers through the binding, not another process on the file | `store` — a `SECURITY DEFINER` trigger with a pinned search path refuses any session without the token; the table owner, a superuser, or a role granted the fence table can still get past it | `entry-point` — MongoDB has no triggers |
| Capture slot | — | a slot is proven decodable before its position is handed to anyone: `start` waits for the transactions open at the slot's consistent point to end, runs one decoding probe, and drops and recreates a slot that fails it; otherwise `CAPTURE_SLOT_UNPROVEN` and nothing is left started (§10) | — |
| Declared record bound | none stated | none stated | `maxRecordBytes` 16 MiB — one BSON document |
| Snapshot | fuzzy | fuzzy | fuzzy |
| DDL transactional | yes | yes | no |
| `schema` port | yes, for a file-backed store | yes | no — there is no SQL surface |
| Native fast path | none | `migration.postgres.logical-copy/v1`, realizing `snapshot-and-tail` — a whole dataset, between two databases | none |
| Driver dependency at runtime | `node:sqlite` (built in) | none — an injected executor | none — an injected executor |

SQLite's retention rule in full: a new subscription starts at the journal head, so it is never owed a
change made before it; with no subscription nobody is owed anything, and a write's journal row is
released in the transaction that wrote it. Rows at or below the least acknowledged position are
deleted on `acknowledge`, on `stop`, on a write when no subscription exists, and when a store is
opened. The store runs with `secure_delete` on. A subscription that stops acknowledging pins the
journal until it is stopped.

**The canonical model is the hub.** A dataset schema gives each field a canonical type (`bool`,
`int64`, `float64`, `decimal`, `string`, `bytes`, `timestamp`, `date`, `uuid`, `json`, `encrypted`),
and a canonical record holds each value in the *one* normal form its type allows. Every engine
captures into `ChangeEnvelope`s of canonical records and applies out of them. That makes cross-engine
movement **hub-and-spoke**: N engines cost N adapters, not N² pairwise migrators, and a new engine is
a source and target for every existing one once it passes conformance. Normal form is also what makes
verification possible: two engines that store one value differently must digest it to the same bytes.

The normal forms, and what the parser refuses rather than alters (`packages/data-core/src/canonical.ts`,
tested in `packages/data-core/test/canonical.test.ts`):

- `int64` is a decimal string within the 64-bit range; `decimal` has no leading or trailing zeros.
- `float64` is finite. `-0` becomes `0` at parse (they digest equal, and engines differ on whether
  they store the sign). `NaN` and the infinities are refused — also anywhere inside a `json` value,
  which is rebuilt in normal form rather than checked in place.
- `timestamp` is UTC with exactly six fractional digits. The input must be a strict RFC 3339 instant
  with an explicit offset; the offset is bounded to ±23:59; the civil fields must name a real instant;
  digits beyond microseconds must be zero. No instant is read through `Date.parse`, so nothing depends
  on the process time zone.
- `string` (and every string inside `json`, keys included) must be well-formed UTF-16: an unpaired
  surrogate is refused, because every engine would store U+FFFD in its place.
- `uuid` is lowercased.
- `encrypted` is exactly `{ alg, keyRef, ciphertext }`. Any other member is refused, not dropped:
  dropping an `iv` or a `tag` would leave a value nobody can decrypt whose digest still agrees on both
  sides. A cipher's nonce or tag is packed into `ciphertext` by whoever encrypted the value.

A same-engine move may use the engine's **native fast path**, declared as a migration profile that
names the pattern it realizes and run through the `nativeTransfer` port. The engine moves the bytes;
the executor keeps everything that makes the move safe — phases, the policy verdict, digest
verification, the fence, the journaled cutover, soak. A run records the realization it used, a run
resumed under the other realization is refused, and there is no fallback from `native` to `hub`: an
unavailable native path is `NATIVE_REALIZATION_UNAVAILABLE`, not a quiet downgrade
(`packages/data-core/test/native-realization.test.ts`). PostgreSQL implements
`migration.postgres.logical-copy/v1` with a publication, a separately created slot, and a
subscription; `pause` is `ALTER SUBSCRIPTION … DISABLE` followed by a wait for the apply worker to
detach (`NATIVE_PAUSE_FAILED` if one stays attached). `pg_dump` stays a migration profile with its
argument builders, but the binding cannot run a process, so it is not declared as a native
realization (§11). A native run has no reverse tail, so its soak rollback is `to-snapshot` (§5, §7).

The envelope stream is a transport channel, **not** event-log facts: payload in the log would make the
log a custody point for data in flight. What the journal records is positions, watermarks, counts,
digests, and — for a native run — the transfer's name and its ticket, which by the port's contract
carries no credential and no record. It records digests of fence tokens, never a token (§6).
`log-pivot` (§5) is the deliberate, named exception.

**Why a scan may be fuzzy.** An executor takes a capture position *before* it opens a snapshot and
replays from that position afterwards. Every change the scan missed or saw half-applied is re-applied
in order, so the copy converges whether or not the engine can give a consistent snapshot. No engine is
required to.

**The type-mapping annex.** Each engine declares canonical ↔ native mappings, each direction classed
`exact`, `widening` (the native type accepts more than HoBo writes), `constrained` (round-trips only
within a stated constraint; a violation is refused loudly), or `lossy` (a value can be silently
altered). A cross-engine plan composes source → canonical → target; a `lossy` edge fails the gate
unless waived by key, and a type either engine cannot carry is unsupported and cannot be waived. A
`constrained` edge never stores a value altered — the conformance kit probes for exactly that.

`encrypted` values are opaque by contract: they move as ciphertext, so no engine, relay, or artifact
needs the key, and destroying the forgetting key erases every copy at once.

## 5. The pattern catalog

Two questions pick the pattern family. **What changes** — *shape* (same store), *placement* (same
engine, different product, region, or tenancy), *engine* (same paradigm), or *paradigm*. And **who is
the authority** — the event log (*projected* data: the store is a derived sink), the store itself
(*authoritative*: an app-owned relational resource or an adopted store,
[ADR-0041](./adr/07-portability-extensibility.md#adr-0041)), or the *journal* (the EventStore's own
persistence, [ADR-0135](./adr/03-data-plane-sqlite-default.md)).

Authority is the pivot, and it is where the event-sourced design pays off: **for projected data the
store was never the truth, so every move — including across paradigms — is a replay.** No capture, no
fence, no translation of stored bytes. The hard patterns exist only for authoritative stores.

| | Shape | Placement | Engine | Paradigm |
|---|---|---|---|---|
| **Projected** | `rebuild-and-swap` · `in-place-evolve` | `rebuild-and-swap` | `rebuild-and-swap` | `rebuild-and-swap` with a new architect-authored mapping |
| **Authoritative** | `in-place-evolve` | `snapshot-and-tail` · `offline-copy` | `snapshot-and-tail` · `offline-copy` · `log-pivot` | `log-pivot` |
| **Journal** | upcasters ([Plan 11](./data-plane.md#plan-11)) — not a migration | `stream-handoff` | `stream-handoff` | — |

| Pattern | What it does | Writes refused | Rollback in the soak window |
|---|---|---|---|
| `in-place-evolve` | expand → backfill → contract in the live store; old and new app versions both run through the dual window | never | to the pre-migration snapshot |
| `rebuild-and-swap` | provision the new sink, replay the log into the new mapping, converge to the live position, verify, shift reads, reap the old sink | never | lossless — the old sink stays valid until reaped |
| `offline-copy` | fence writes → copy → verify → flip → release | for the whole copy | lossless with a reverse tail, else to-snapshot |
| `snapshot-and-tail` | seed from a snapshot, tail captured changes until caught up, verify, shift reads progressively, fence and flip write authority once, tail in reverse through the soak window | only for the fence-and-flip step | lossless with a reverse tail, else to-snapshot |
| `log-pivot` | adopt the store, capture its changes into the log as domain events, serve the target as a projection of the log | only for the fence-and-flip step | none — **authority has moved into the log** |
| `stream-handoff` | copy event streams to a new store by position, quiesce the single writer, drain the tail, flip the writer | only for the fence-and-flip step | to-snapshot |

A **reverse tail** is capture on the target applied onto the source, **and the target's `fence`**:
the catalog's reverse-tail ports are `apply` on the source and `capture` plus `fence` on the target.
Capture and apply keep the old side current after the flip. The fence is what makes going back
lossless: without it the target can acknowledge a write between the rollback's last digest and the
flip, and that write is gone. A target with capture and no fence therefore gets `to-snapshot`, from
the selector and from the executor alike (`packages/data-core/test/executor-findings.test.ts`).
Without a reverse tail the old side goes stale at the flip, and the executor reports
`rollback: "to-snapshot"` rather than claiming otherwise.

**A native run has no reverse tail.** The engine's transfer is closed once the cutover is journaled
and before authority moves — left open it would carry the old side's retirement to the new authority
as deletes — and nothing tails back. Its soak rollback is `to-snapshot` whatever ports the two
engines have.

**Same-schema `log-pivot` needs the source's `verify` port.** When the sink keeps the source's schema
the pivot is verified by digest, so the store being adopted must be able to give one: the executor
refuses the run with `PORT_MISSING` before anything is journaled, and `migration.Verified` says
`compared: true` only after a comparison was made (`executor-findings.test.ts`). This is the
executor's requirement; the catalog's port list for `log-pivot` does not include `verify`, so the
selector does not gate on it. When the schema changes, the evidence is positional and no digest is
compared.

`log-pivot` is a one-way door and is labelled as one. It is also the only honest answer to
cross-paradigm movement of an authoritative store: relational → document is a *re-model*
([data-plane non-goal](./data-plane.md#projection-scope)), and the `toEvents` function is where that
re-modelling is written down, reviewed, and replayable. What is automated is the movement,
verification, and cutover — never the modelling.

**Application-level dual-write is not in the catalog, by decision.** Two independent writes with no
shared transaction diverge on the first partial failure, and the divergence is silent. Every pattern
keeps **exactly one write authority at any log position**; the second store is fed by capture, and
authority changes hands only under a fence token. This is the single-writer rule the EventStore
already enforces ([ADR-0135](./adr/03-data-plane-sqlite-default.md)), applied to migration. The
existing `migrate.dual-write` offering id and `cdc-dual` step mode name this *dual-run* behaviour.

## 6. One phase model, one aggregate

Every pattern is a subset of one ordered phase list, so one aggregate, one event family, and one set
of gates cover all six:

```
plan → gate → prepare → seed → converge → verify → shift-reads → fence-and-flip → soak → finalize
```

| Phase | Meaning | Safe hold? |
|---|---|---|
| `prepare` | provision the target, take the capture position | yes — nothing has moved |
| `seed` | snapshot copy / replay from zero; chunked, idempotent | yes — the source is the sole authority |
| `converge` | tail until caught up | yes — indefinitely; costs a second copy |
| `verify` | bucketed digests, re-checked on mismatch | yes |
| `shift-reads` | progressive read ramp; reads are idempotent, so reversible at any percentage | yes |
| `fence-and-flip` | raise the fence, drain, verify exactly, move write authority | **no** — completes or compensates |
| `soak` | the rollback window; the reverse tail keeps the old side current where the pattern has one | yes |
| `finalize` | retire the source, stop subscriptions | terminal, destructive |

A **safe hold** is a state the migration can sit in indefinitely without losing data or violating
policy. A hold raised *inside* a phase must name a safe-hold phase. If exact verification under the
fence fails, the step compensates: reads go home, the fence is released, and the source remains the
authority. A compensated run that later succeeds puts reads back where the ramp left them before it
decides the cutover (`executor-findings.test.ts`).

**A hold between two phases is a fact wherever it falls.** A negative verdict or a requested pause
arrives between phases, when nothing is half-done, so it is recorded as `migration.Held` even after
the flip. A copy pattern straight after its flip holds in `soak`. A pattern without a soak window
(`log-pivot`, `stream-handoff`) records `phase: "fence-and-flip"` with `before: "finalize"`
(`executor-findings.test.ts`).

### The journal is a compare-and-set

`MigrationJournal.append(migrationId, fact, expectedCount)` appends only when the journal holds
exactly `expectedCount` facts — the number the run loaded plus those it appended — and throws
`JournalConflictError` (`JOURNAL_CONFLICT`) otherwise, appending nothing.
`createEventStoreMigrationJournal` passes the count as the stream's `expectedSeq` (one stream per
migration, `migration:<id>`) and never re-reads the head.

Two drivers of one migration are excluded in four ways. The first two stop a driver whose view is
out of date *before* it acts (`packages/data-core/test/two-drivers.test.ts`); the last two stop one
that won its fact and then stalled *inside* the side effect
(`packages/data-core/test/second-review.test.ts`).

- **A fact comes before every side effect that moves or releases write authority, or changes a store
  in place**, so the driver whose view is out of date loses its next append and stops before it acts.

  | Before | the run journals |
  |---|---|
  | a write fence is raised (the source at the cutover, the target at a rollback) | `migration.FenceRequested` — and, once it is up, `migration.FenceRaised` with the digest of its token |
  | a fence is released because verification under it failed | `migration.Held`, with `compensated: true` |
  | write authority moves to the target | `migration.CutOver` |
  | write authority moves back to the source | `migration.RollbackDecided` |
  | an in-place phase runs its statements | `migration.PhaseIntended` |
  | an in-place store is restored from its snapshot | `migration.RollbackDecided` |

- **A stale applier is refused by the store.** Every batch a copy executor applies is conditional on
  the leg's watermark (§4), and that watermark is stored as `<journalHead>@<position>` — the journal
  head of the driver that wrote it. Before anything is compared under a fence, the cutting-over
  driver stamps its own head on the leg; a driver with an older view then names a watermark that is
  gone, and one that reads the leg afresh sees a head newer than its own. The event-log executors
  apply conditionally too.

- **A late authority move is refused by the router.** Every move of write authority carries an
  `AuthorityMoveRef { migrationId, head }`: `flipAuthority` of the copy patterns (`AuthorityFlip`),
  and `flipAuthority` of `log-pivot` and `flipWriter` of `stream-handoff` (`AuthorityHandover`).
  `head` is the number of facts up to and including the journaled decision the move carries out —
  `migration.CutOver` or `migration.RollbackDecided` — so the same decision carries the same head
  whichever run delivers it, and a later decision a higher one. The router's contract:

  1. keep, durably and per migration, the highest `head` it has applied;
  2. apply a move whose `head` is that or higher, recording the head **in the same step that moves
     authority** (a move at the head already applied is the same decision again — a resumed run
     finishing a crashed flip — and must be applied again);
  3. refuse a move whose `head` is lower with `StaleAuthorityMoveError` (`STALE_AUTHORITY_MOVE`),
     moving nothing.

  `admitAuthorityMove(applied, move)` is those three steps over a `Map`. So a driver that journaled a
  cutover, stalled in the router call, and was overtaken by a rollback has its flip refused when it
  finally lands.

- **A fence is used only by the migration that can prove it raised it.** The fence port cannot say
  who raised a fence — raising a raised one answers its token to anyone — so the copy executors prove
  ownership from the journal. Before raising they ask `status`. A fence already standing is written
  through, adopted, or released only when its token digests to the last `migration.FenceRaised` this
  migration journaled for that side (for the source after the cutover, to the cutover's
  `fenceTokenDigest`). Anything else holds with `FENCE_NOT_OWNED`, and the fence is left exactly as
  it stands. And nothing new is decided under a fence a hold was journaled against: the driver that
  held may still have its release in flight, so the next attempt releases that fence and raises a
  fresh one, and the late release then names a token that opens nothing.

A driver that meets a refusal — `JOURNAL_CONFLICT`, `STALE_APPLY`, or `STALE_AUTHORITY_MOVE` — has
been superseded: it records nothing further, compensates nothing, and rethrows.

**What remains, stated plainly.**

- **A router that ignores `head`.** The head rule is the router's to implement; the executor only
  supplies the number. A router that ignores it still serves a single driver and does not protect
  against a late one.
- **`shiftReads` carries no head.** A compensation's "reads go home" that lands late moves reads —
  not writes — to an old side that may by then be fenced.
- **A fence raised by someone else in the same instant.** When a run died between its raise and the
  `migration.FenceRaised` that records it, the next run takes a fence it finds standing to be the one
  requested and records its digest then. A fence another party raised in that same window cannot be
  told apart; the port reports no owner.
- **Fence ownership is proven in the copy executors only.** `log-pivot` and `stream-handoff` journal
  `migration.FenceRequested` and the cutover's digest, but no `migration.FenceRaised`, and do not ask
  `status` before raising or quiescing.

Run one driver per migration; these are the safety net, not a lease.

### Holds, policy, and a native transfer

**A held native run stops its transfer.** A held migration moves nothing: the hub is driven by the
executor and stops with it, and the engine's own transport is told to — `nativeTransfer.pause` on the
target, after the hold is journaled, and `resume` when the next phase that needs the transfer runs.
Three holds are the exception, because in them the transfer *is* the work the last verdict approved
and the run stopped only because its bounded wait was spent: the native initial copy has not
finished, the lag did not fall within bound, and a native `offline-copy` did not finish inside its
fence window. Those leave the transfer running. The reason is the engine's: PostgreSQL starts an
unfinished table copy again when a subscription is re-enabled, so pausing there would restart the
copy every time the run came back.

**Rollback against policy.** Two rules, for the copy patterns' soak window:

- **A decided rollback finishes whatever the verdict says.** Once `migration.RollbackDecided` is
  journaled the phase is not put to policy at all. What is left of it — handing write authority back
  and releasing the fence — is what ends the exposure a negative verdict objects to, and holding it
  would leave both stores fenced.
- **A requested rollback is allowed under a negative verdict.** Going back moves authority to the
  store the data already lived in. The decision then records the finding codes it ran under in
  `policyFindings`. Any other soak decision under a negative verdict holds as before.

A decided *cutover* gets no such exemption: a run that journaled `migration.CutOver`, crashed, and
resumes under a negative verdict holds, with the source still fenced (§10).

**A `to-snapshot` rollback does not wait for a target that is gone.** That rollback abandons the
target, and the usual reason to abandon it is that it has failed. Fencing the target and stopping the
target's half of a native transfer are therefore best effort: `migration.RollbackDecided` records
`targetFenced`, and the result's impedance lists `ROLLBACK_TARGET_UNREACHABLE` when the target could
not be reached. The source's side — the erasure replay, dropping its half of the transfer, the flip,
releasing its fence — always runs. A fence someone else holds on the target is not "unreachable"; it
is a `FENCE_NOT_OWNED` hold. A lossless rollback still needs the target: there is no proving the
source current without it.

### What resume does at each crash window

Tested in `packages/data-core/test/crash-windows.test.ts` and `second-review.test.ts`, which kill a
run before and after each side effect of the forward path, a compensation, and a rollback, for both
realizations; the kit holds every engine to the cutover, compensation, and rollback windows (§9).

| The run stopped | The next run |
|---|---|
| inside a phase before the flip, no decision journaled | runs that phase again from its start. A seed re-applies idempotently and conditionally |
| after `migration.FenceRequested`, before `migration.FenceRaised` | if a fence is standing, takes it to be the one requested and journals its digest; if none is, requests and raises one |
| under the source's own fence, before the cutover was decided | finds the source still fenced: it has refused writes since the crash and keeps refusing them until this run. The fence's token digests to the journaled one, so it is used: the step verifies again and either flips or compensates |
| after a compensation's hold was journaled, before the fence was released | releases that fence — a hold was journaled against it — and raises a fresh one, then verifies again |
| …and the fence standing is not one this migration journaled | holds with `FENCE_NOT_OWNED`; the fence is neither adopted nor released |
| after `migration.CutOver`, before or after the router call, before the phase fact | **finishes the move**: asks the store whether the fence is up, gets the token back by raising it, checks it against the journaled digest, and calls `flipAuthority` again with the cutover's head. It never re-verifies against a target that has since taken writes |
| …and the fence is down, or is not the one the decision was made under | holds for a person. It neither flips nor puts a fresh fence on a store that may be the authority |
| …and the router has since applied a later decision | is refused with `STALE_AUTHORITY_MOVE` and stops |
| after a target fence was requested for a rollback, before any decision | if it is not going to roll back and the fence is provably its own: journals a hold, releases the target's fence, and stops, so the new authority is not left refusing writes |
| after `migration.RollbackDecided`, anywhere before `migration.RolledBack` | **finishes handing authority back**, without consulting `soakDecision` or the policy verdict. The source's fence is released last, so finding it down means only the record is missing |
| after the source's `retire` committed, before the `finalize` fact | finds the scope empty behind the migration's own fence and completes, instead of mistaking it for a source that changed |
| in place: after `migration.PhaseIntended`, before `migration.PhaseApplied` | asks the phase's probe (§3): records the phase as applied, applies it under a fresh intent, or holds with `PHASE_OUTCOME_UNKNOWN`. It never restores the snapshot on this account |

`completed` and `rolled-back` **absorb**: the fold ignores any fact appended after either, and a
finished migration run again is a no-op, not a second cutover.

### The migration is an aggregate

An executor emits `migration.*` facts; the state is `foldMigration` over them, after
`liftMigrationFacts` has brought what was loaded to today's bodies. `MIGRATION_FACT_VERSIONS` is the
version each fact body is journaled at, the bodies are pinned in `@hobo/events`
(`packages/events/src/upcaster-corpus.ts`), and
`packages/events/test/migration-fact-contracts.test.ts` runs every executor and validates each fact
it emits against the current pinned version.

| Fact | Version | Body, and what changed |
|---|---|---|
| `migration.Planned` | 2 | v1 is pinned to what the v1 executors wrote: `phases` as a list, plus optional `pattern`, `decisionDigest`, `custodyDigest`, `source`, `target`, `dataset`. v2 adds `realization` and `profile`. The upcaster carries everything a v1 plan said — the pattern above all, which a resume is checked against — and names an in-place plan `in-place-evolve` |
| `migration.SnapshotTaken` | 1 | unchanged |
| `migration.PhaseIntended` | 1 | **new.** `migrationId`, `phase` (`expand`, `backfill`, or `contract`), `statements`, `intendedAt`; optional `retry` |
| `migration.PhaseApplied` | 2 | v1 is pinned to what was written: `statements` optional, `checkpoint` optional — and a v1 `fence-and-flip` checkpoint carried the fence token. v2 withdraws that token: the upcaster replaces it with `fenceTokenDigest`. Optional `recovered` marks an in-place phase the probe found already in effect |
| `migration.Verified` | 1 | optional additions: `count`, `digest`, `compared` |
| `migration.FenceRequested` | 1 | `migrationId`, `side` (`source` or `target`), `phase`, `requestedAt` |
| `migration.FenceRaised` | 1 | **new.** `migrationId`, `side`, `phase`, `fenceTokenDigest`, `raisedAt` — written after a raise, by the copy executors |
| `migration.CutOver` | 2 | `fenceToken` withdrawn, `fenceTokenDigest` and `fencedFrom` added; `count`, `digest`, `reverseTail`, `reversePosition`, `authority`, `logPosition` modelled. Upcaster digests a v1 token and drops it |
| `migration.Held` | 1 | optional additions: `compensated`, `before`, and `failedPhase` (the in-place phase whose statements the port reported as failed) |
| `migration.Resumed` | 1 | unchanged |
| `migration.RollbackDecided` | 1 | `migrationId`, `lossless`, `decidedAt`; optional `erasuresFrom`, `count`, `digest`, and now `targetFenced` and `policyFindings` |
| `migration.RolledBack` | 2 | `snapshotRef` is no longer required (a copy pattern rolls back to the old store, not to a snapshot); `lossless`, `erasuresReplayed` added |
| `migration.Completed` | 1 | unchanged |
| `migration.Failed` | 1 | unchanged body; `reason` is a class name plus a stable code (below) |

`migration.Exported` and `migration.Imported` belong to the same family and are not emitted by these
executors. `in-place-evolve` ends a successful run with `migration.CutOver`, as the original executor
did, not with `migration.Completed`.

**The journal carries digests of fence tokens, never a token.** A fence token lets its holder write
through the fence and retire the source; a journal is evidence, read by people and systems that must
not gain that. `migration.FenceRaised`, `migration.CutOver`, and the `fence-and-flip` checkpoint
record `fenceTokenDigest` (`sha256:` of the token). A later phase or a resumed run asks the store
again — raising a raised fence answers its token — and holds if the digest no longer matches. The kit
asserts that no fact carries the token. A journal written before tokens were kept out still resumes:
it is lifted on load, so the token is digested before any fold or result sees it. The stored events
themselves are not rewritten, so the event store still holds what was written.

**Errors are recorded as a class name plus a stable code**, never a message — a thrown message can
carry a connection string. `migration.Failed.reason` is the error's class name, followed by its code
when the error is a `DataCoreError` (for example `DataCoreError: NATIVE_TRANSFER_REFUSED`). The
in-place executor records failures the same way in its facts and in its result
(`in-place-resume.test.ts`).

## 7. Pattern selection is deterministic and recorded

Choosing a pattern is a Matching-class decision ([ADR-0033](./adr/01-architecture-core.md#adr-0033)):
`selectMigrationPattern` is a pure function — no clock, no I/O, no model on the path — and the same
inputs always produce the same digest.

**Hard gates, fail-closed.** Each names its reason code in the decision.

| Gate | Rule | Reason code |
|---|---|---|
| Legality | the pattern is defined for this authority and change | `PATTERN_ILLEGAL_FOR_CELL` |
| Ports | both engines declare the ports the pattern drives | `ENGINE_DECLARATION_MISSING`, `PORT_MISSING` |
| Mapping | the composed type mapping has no un-waived `lossy` edge; a cross-engine move with no schema is *unverified*, not assumed exact | `MAPPING_BLOCKED`, `MAPPING_UNVERIFIED` |
| Evidence | conformance evidence for every engine involved is `pass` and fresh (rule below) | `EVIDENCE_MISSING`, `EVIDENCE_FAILED`, `EVIDENCE_STALE`, `EVIDENCE_POSTDATED` |
| Policy | the verdict is positive | `POLICY_DENIED` |
| Custody | the verdict's path names every custody role this candidate creates (§8) | `CUSTODY_INCOMPLETE` |
| Freeze | the write freeze fits the declared budget; an unestimated freeze is never treated as zero | `FREEZE_UNESTIMATED`, `FREEZE_EXCEEDS_BUDGET` |
| Rollback | the soak rollback posture is at least what was required | `ROLLBACK_INSUFFICIENT` |

**The evidence rule.** An engine may have several evidence entries and all of them are read — never
the first one found, so `[pass, fail]` and `[fail, pass]` are the same evidence. The entry that counts
is the **newest**; when several share that instant, the **worst** of them (`fail`, then `unknown`,
then `pass`). A later pass therefore supersedes an earlier failure. An entry the gate cannot place in
time fails its engine whatever else is listed, because it cannot be shown to be older than a passing
run: one dated after `now` is `EVIDENCE_POSTDATED`, and one whose `checkedAt` is not a readable
instant is `EVIDENCE_STALE`, as is a passing entry older than `evidenceMaxAgeMs`.

**Estimates and limits.** `flipMs` and `copyMs` must be finite and zero or more; `NaN`, an infinity,
or a negative is not an estimate and yields `FREEZE_UNESTIMATED`. The same holds for the custody and
cost estimates used in ordering, which then rank last. `maxWriteFreezeMs` and `evidenceMaxAgeMs` must
themselves be finite and zero or more, or the request is refused with `INVALID_SELECTION_REQUEST`.

**Instants are strict.** `now`, every `checkedAt`, and every custody `retainUntil` are RFC 3339 with
an explicit offset, read by one function (`instantMicros`) and compared to the microsecond. An
instant with no offset is malformed, never local time; a deadline equal to `now` has passed.
`packages/data-core/test/instants-timezone.test.ts` runs the same inputs in child processes under
three time zones and requires the same answers.

**Then lexicographic order — never a weighted score**
([ADR-0151](./adr/07-portability-extensibility.md#adr-0151) §11): stronger rollback posture → less
write freeze → native realization over the hub → fewer custody points → lower estimated cost → stable
pattern id.

**Native candidates.** When source and target are the same engine and both declare a native profile
for a pattern, the decision holds two candidates for it: `native` and `hub`. The native candidate is
not asked for the ports the engine's own transport replaces (`snapshot` and `capture` on the source,
`apply` on the target) and still needs the rest. It carries no reverse tail, so its soak posture is
the pattern's weaker one. Because rollback posture is compared first, **a hub candidate with a
reverse tail (`lossless`) outranks the native one (`to-snapshot`)**; native wins the selection only
when the hub has no reverse tail to offer, and it can never satisfy `requiredRollback: "lossless"`.
A caller that wants the native path anyway passes that candidate's `realization` and `profile` to the
executor; the decision will show it was not the selected one.

**No silent downgrade.** Every pattern in the catalog appears among the candidates. When nothing
survives, the decision names a reason for each — the same agent-correctable shape as
`deployment.PlanRejected` — instead of falling back to a pattern that needs downtime.

## 8. Policy holds for every intermediate state

A move that is compliant at both ends can still be non-compliant in the middle. A plan therefore
carries a **custody path**: every place the data rests or passes — source, target, event log, the log
a journal is handed off into, staging artifacts, the runner that relays rows, capture logs, the
rollback snapshot, the retiring source —
each with a region, the protections it provides, and for a bounded copy a retention deadline. The
verdict is *computed* from that path by `evaluateCustodyPath`, which takes no boolean that says
"policy allows it".

| Invariant | Rule | Where it is enforced |
|---|---|---|
| **Residency at every custody point** | each point's region passes `evaluateResidency`; an unmapped region is a conflict | `evaluateCustodyPath`, over the `@hobo/core` jurisdiction port ([ADR-0146](./adr/02-identity-security.md#adr-0146)) |
| **No protection downgrade** | every point provides what the data's classification requires | `evaluateCustodyPath`; the requirement table is an input, so a policy pack can tighten it |
| **Bounded copies** | every non-permanent point has a retention deadline, and none has outlived it | `evaluateCustodyPath`, evaluated against the injected instant |
| **Custody completeness** | the path names every role the migration creates; a copy nobody judged is not approved | `evaluateCustodyPath` given the migration; the selector; every executor before every phase; `can-trail` (below) |
| **Erasure continuity** | `encrypted` fields move as ciphertext and are never decrypted in flight | the canonical model; the kit's round-trip case |
| **No resurrection** | a rollback that goes back to a stale store, or a restore from a snapshot, re-applies the erasures recorded since — and does not proceed when it has no way to | `ErasureLedger` in the copy executors; `replayErasures` in `in-place-evolve`; kit cases (below) |
| **Tenant scope** | `snapshot`, `capture.start`/`read`, `verify`, `fence`, and `retire` take a `DatasetScope` (dataset plus tenant; an empty tenant spans all). `records.write` and `apply` take only a `dataset`: each mutation carries its own tenant, and an apply watermark is per dataset and source, not per tenant | the SPI request types; kit cases for tenant isolation, scoped capture, scoped digest, scoped retire, and a tenant move |
| **Evidence, not payload** | facts, digests, and conformance reports carry no record and no fence token | the `verify` port; kit cases assert a sentinel payload and the token never appear in facts |
| **Single write authority** | a fenced writer is refused; authority flips once; a second driver is excluded (§6) | the `fence` port; the conditional `apply`; the journal's compare-and-set; the router's compare-and-set on the journal head; fence ownership by journaled digest |

**Custody completeness.** A pattern creates copies beyond its two ends, and a path that leaves one
out was never judged there. `requiredCustodyRoles` derives what each migration creates from the
catalog — the ports a pattern drives are the places it puts data:

| Role | Created when |
|---|---|
| `source` | the pattern drives source ports |
| `target` | the pattern drives target ports |
| `event-log` | the pattern drives no source port (the log is what it reads), or authority moves into the log |
| `relay` | the hub realization carries every record through the runner — not for `native`, and not for `in-place-evolve` |
| `capture-log` | the source's `capture` port; a reverse tail (the target's log); a native transfer, which retains the log itself |
| `rollback-snapshot` | the source's `schema` port, which snapshots before any change |
| `retiring-source` | the source's `retire` port |
| `target-event-log` | the authority being moved is the journal itself (`stream-handoff`): its streams land in another log. A role of its own, not a second `event-log` point — a verdict lists roles, and a list of roles cannot say that two different logs were both judged. Permanent, like `event-log` |

A `staging-artifact` is never implied; a plan that writes one names it. Four things read the table
(`packages/data-core/test/custody.test.ts`, `executor-findings.test.ts`,
`packages/trails/test/can-trail-custody-coverage.test.ts`):

- `evaluateCustodyPath({ path, policy, now, migration })` — given the migration, each missing role is
  a `CUSTODY_PATH_INCOMPLETE` finding and the verdict is negative. An unstated realization or reverse
  tail takes the more demanding reading.
- `PolicyVerdict.roles` — every verdict carries the roles its path named. Without a `migration` the
  verdict is for the path as declared and no more: a path of only source and target can be `ok` as a
  path, and it selects no pattern.
- The selector rejects a candidate whose roles are not all in `roles` (`CUSTODY_INCOMPLETE`).
- **A run holds on a verdict that does not cover the copies it creates.** Before every phase the run
  loop checks the verdict's `roles` against what its pattern, realization, and reverse tail create,
  and holds — a `migration.Held` whose reason names `CUSTODY_PATH_INCOMPLETE` and the roles — before
  it touches a store. `in-place-evolve` does the same for `source` and `rollback-snapshot` when a
  policy callback is wired; with none wired it checks nothing. A verdict with no `roles` member names
  none and covers nothing.

**Continuous means re-evaluated, not evaluated once.** A migration can sit in `converge` for days. The
executors recompute the verdict before **every** phase. A verdict that turns negative holds the
migration at its last safe state and records why in a `migration.Held` fact; nothing in the phase
runs, and a native transfer is paused so that nothing moves either (§6). Before the flip the source
stays the writable authority; after it the target is. Two things are not held by a negative verdict:
a rollback already decided, and a rollback asked for out of the soak window (§6). When the
caller runs the executor again with the same journal and the verdict passes, the run records
`migration.Resumed`, skips the phases that already have a fact, and runs the held phase from its
start (`packages/data-core/test/migration-run.test.ts`). `in-place-evolve` does this only with a
journal (§3). Because retention is evaluated against the instant, the *same* path fails later once a
copy outlives its deadline — which is the point.

**Erasure replay is fail-closed and windowed from before the fence**
(`executor-findings.test.ts`, `in-place-resume.test.ts`):

- A `to-snapshot` rollback needs the `erasures` ledger. Without one it holds and nothing is rolled
  back: no ledger is not the same as no erasures. A caller with nothing to replay supplies a ledger
  that returns none.
- The ledger is asked from the instant the source's fence was **first requested**
  (`fencedFrom` on `migration.CutOver`, taken from the first `migration.FenceRequested`), not from
  the cutover instant. An erasure that arrives while the source is fenced is dated before the cutover
  and never reached the source; a window starting at the cutover would skip it.
- **The ledger is read twice** in a `to-snapshot` rollback: before authority goes back, and again
  after it has and before the source's fence is released. An erasure that reached the abandoned
  target between the first read and the flip is in the ledger and not on the source; the second read
  replays it (`packages/data-core/test/second-review.test.ts`).
- `in-place-evolve` needs `replayErasures` to restore. Without it a failed phase holds and the store
  is left as it is. A phase whose outcome is unknown is never answered by a restore at all (§3).
- A lossless rollback replays nothing: before its decision is journaled the source is drained to the
  target's head and proven digest-equal to it, with the target fenced.

**The `can-trail` gate is conjunctive and fails closed on a verdict it cannot read.** It combines
three signals and none supersedes another: the trail is denied when `policyAllows` is `false`, or
`residencyConflict` is `true`, or the supplied verdict is negative or carries a finding. A passing
verdict does not lift a denial stated beside it. A verdict that is not the pinned record (`ok`, a
`findings` list, a `sha256:` `custodyDigest`, `roles` a list of role names) blocks the trail with a
`policy-denied` reason; it neither throws nor passes. When a data step names its pattern, every role
that pattern creates must be among the verdict's `roles`. A relay in a denied region blocks the trail
and the reason names the custody point (`packages/trails/test/can-trail-policy-gate.test.ts`,
`can-trail-custody-coverage.test.ts`, `data-engine-contract.test.ts`).

What the gate does not do: the two booleans are still caller-asserted, and a caller that supplies no
verdict and no denial is not blocked by this part of the gate. The computed verdict is an additional
conjunct, not a replacement for the inputs it sits beside.

## 9. Verification

One suite, `runEngineConformance` in `@hobo/data-core`, run against any binding through a harness
that creates fresh stores. Passing `peer` makes the pattern cases cross-engine: the engine under test
is the source and the peer is the target. `ENGINE_CONFORMANCE_CASE_IDS` is the list of cases and
`NATIVE_CONFORMANCE_CASE_IDS` the subset that proves a native realization. The kit proves each port
holds the property an executor relies on, then runs the executors themselves over the engine —
including with the run killed at the side effects where a crash is dangerous. This section describes
it by family — a family is the prefix of its case ids — and leaves the counts to the dated table
below.

| Family | What a pass proves |
|---|---|
| `declaration` | the binding provides exactly the ports and native profiles it declares |
| `datasets` | provisioning is idempotent and describable; a dataset named after the engine's own bookkeeping is refused or harmless |
| `records` | every canonical type reads back byte-identical; the same key in two tenants is two records; null and empty stay distinct; an undeclared open-schema field survives, one named `__proto__` included; a key is the canonical key of its record (a mismatched or non-canonical one is refused, and leaves nothing); a record over the declared `maxRecordBytes` refuses its whole batch |
| `mapping` | a value at the edge of what the engine can hold round-trips exactly or is refused — never stored altered; a first-century timestamp round-trips or is refused when written, never accepted and then unreadable |
| `capture` | changes arrive in commit order, strictly after the start, non-consuming, with an idempotent start; a scoped subscription sees only its tenant; one write is read whole, whatever the limit; an update of a record with a very large key is captured under that key; a position the engine never minted, one past its head, or one already acknowledged is an error, never an empty batch; a subscription name is bound to its scope |
| `apply` | re-applying a batch changes nothing; the watermark is recorded and an empty batch advances it; a conditional apply that names a stale watermark is refused and changes nothing, and of two appliers naming the same watermark exactly one lands |
| `verify`, `snapshot` | the engine's digest equals the canonical digest of the same records and carries no payload; a scan returns every record in scope once, within its tenant |
| `fence` | raising a raised fence returns its token; a fenced write is refused with `FencedWriteError` and the token writes through; a dataset-wide fence covers every tenant; the wrong token opens nothing; an `apply` honours the fence; writes racing `raise` either land before it returns or are refused; a fence raised after a release has a new token |
| `retire` | refused without the fence, with another fence's token, and with a stale digest; removes exactly its scope; a redelivered retire is harmless; what it removed is not replayed to a subscription started afterwards |
| `errors` | a refusal carries no record payload and no credential |
| `schema` | snapshots are per binding; a multi-statement entry runs whole or is refused; a verify query cannot carry a second statement |
| `pattern.snapshot-and-tail` | zero loss with writes arriving between phases and authority moving once; resume to completion after a crash following each phase's fact; a write made after the flip survives a rollback under a reverse tail; without one the posture is `to-snapshot`, the loss is stated, and an erased subject stays erased; one tenant leaves a pooled store and the other is untouched; the source's retirement stays on the source; no fact carries a record or the fence token |
| `pattern.snapshot-and-tail.crash-windows` | the run killed **before and after** each named side effect of the cutover (raising the source's fence, the `migration.CutOver` append, the flip, stopping capture), of a compensation (the hold's append, the fence release), and of a rollback under a reverse tail (the target's fence, the decision's append, the flip back, the source's fence release, stopping the reverse capture): every resumed run reaches one outcome and at no point are two stores writable |
| `pattern.snapshot-and-tail.native` | zero loss with the engine carrying the records and writers racing the fence; resume at every boundary; the cutover's crash windows; the journal records the realization; retiring the source does not reach the target through the engine's transport |
| `pattern.offline-copy` | a fenced copy arrives complete and the source is retired |
| `pattern.in-place-evolve` | a consumer on the old shape blocks the destructive phase and keeps the dual window open; a failed phase restores the snapshot and re-applies erasures, and the same plan then completes |

**Crash injection is part of the package** (`packages/data-core/src/crash-injection.ts`). A
`CrashInjector` sits in front of every port — `nativeTransfer`'s `pause` and `resume` included — the
journal, and the caller's callbacks. It counts side effects and kills the run at one of them, either
before the call ran or after it ran and before anyone heard back; once dead, every further call
through a wrapped port throws, as a dead process runs no `catch` block. The kit uses it for the
crash-window cases, with routers that keep the highest journal head they applied
(`admitAuthorityMove`), as a real one must. The executor tests use it to sweep every side effect on
the reference engine (`crash-windows.test.ts`).

**What is still not modelled.** A crash-window case resumes with the **same binding objects** the
killed run used. It does not model a process restart: fresh connections, a binding constructed anew,
or whatever state a binding keeps in memory being gone. The two-driver scenarios, the in-place
probe paths, and the event-log patterns are proven on the reference engine by `@hobo/data-core`'s own
tests (`two-drivers.test.ts`, `second-review.test.ts`, `in-place-resume.test.ts`,
`event-log-executors.test.ts`), not per engine by the kit.

**The kit is tested against itself.** `packages/data-core/test/conformance-self-test.test.ts` runs it
over 27 deliberately broken engines — a reference engine with one defect each
(`test/support/broken-engines.ts`): a fence that does not span tenants, a retire that takes any
token, an acknowledge that accepts any position, a declared size bound that is not enforced, and so
on —
and requires every one to fail at the case written to catch that defect. A variant that passes is a
hole in the kit.

**Statuses and the fold.** A case result is `pass`, `fail`, `blocked` (a case it depends on failed),
`not-run` (it applies but could not be exercised), or `declared-limit`. The fold is pessimistic:

- any `fail` or `blocked` makes the outcome `fail`;
- any `not-run` makes it `unknown`, and `unknown` is as non-selectable as `fail`;
- **a filtered run folds to `unknown` at best.** A run restricted with `only` proves what it ran and
  nothing else; the report records the filter, and one case run on its own can never be presented as
  conformance;
- a case whose port the engine does not declare is skipped — not forgiven: the pattern needing that
  port is ineligible at selection. A native case is skipped the same way when engine and peer share
  no native profile, and the size case when the declaration states no `maxRecordBytes`.

`declared-limit` is the one status that is neither a pass nor a failure. An engine that does not hold
a property, and says so with an impedance code in its declaration, lists the case in its harness's
`declaredLimits`. The case still runs. Failing its expectations it is reported `declared-limit`,
recorded for whoever selects the engine and not counted against the outcome. Passing, it **fails**:
the declaration then states a limit the engine does not have. Only cases the kit marks as limitable
are honoured, and only for a code the declaration really lists — nothing a migration's safety rests
on can be declared away.

What runs where:

| Lane | Runs in the default test lane | What it exercises |
|---|---|---|
| Reference engine, same- and cross-engine | yes | the kit itself, the self-test, and every executor |
| SQLite ↔ SQLite, SQLite ↔ reference (both directions) | yes | the kit against real files, including `in-place-evolve` over real DDL |
| Event-log patterns on the real SQLite event store + SQLite engines | yes (`packages/trails/test/data-patterns-e2e.test.ts`) | `rebuild-and-swap`, `log-pivot`, `stream-handoff` on disk; the migration journal on the event store |
| MongoDB over its in-memory executor | yes | the binding's logic without a server; the executor interleaves transactions, so the fence race case can fail offline |
| PostgreSQL, live | CI job `Live data engines`; locally with `HOBO_TEST_POSTGRES_URL` | the kit against a real server, including logical-decoding capture and the native logical-copy cases |
| MongoDB, live | CI job `Live data engines`; locally with `HOBO_TEST_MONGODB_URL` | the kit against a real replica set, including change streams |
| Cross-engine among SQLite, PostgreSQL, and MongoDB, live | CI job `Live data engines`; locally with both variables | real records moving between real engines of different paradigms |

To run the live lanes locally, start the two servers from the compose file and run the one command
(details in [live-provider-matrix](./live-provider-matrix.md#data-engines-packagesdata--adr-0177)):

```bash
docker compose -f packages/data-core/deploy/compose.live-engines.yml up -d --wait
pnpm run test:data-live
```

### Last recorded run

**Recorded 2026-11-10 at commit `45102736`.** PostgreSQL 16.15 with `wal_level=logical`, MongoDB
8.0.4 single-node replica set. When the kit changes, the "Kit size" line and the two tables under it
are the only numbers in this section to refresh.

Kit size at this commit: **52** case ids, of which 3 are native cases, 5 need the `schema` port, and
1 (the size case) needs a declared `maxRecordBytes`.

| Kit run, engine as its own peer | Outcome | Passed | Declared limit | Skipped | Why skipped |
|---|---|---|---|---|---|
| Reference engine | `pass` | 43 | — | 9 | the size case (no bound stated), the 3 native cases, the 5 `schema` cases |
| SQLite | `pass` | 48 | — | 4 | the size case, the 3 native cases |
| PostgreSQL, live | `pass` | 51 | — | 1 | the size case |
| MongoDB | `pass` | 43 | 1 | 8 | the 3 native cases, the 5 `schema` cases |

MongoDB's declared limit is `capture.acknowledged-positions-are-final`, under
`MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING`: its `acknowledge` releases and checks nothing, so a
read from before an acknowledged position still succeeds.

| Package | Tests, default lane | Tests, live lane (`pnpm run test:data-live`) |
|---|---|---|
| `@hobo/data-core` | 286 passed | 286 passed |
| `@hobo/data-sqlite` | 40 passed | 40 passed |
| `@hobo/data-postgres` | 311 passed, 41 skipped | 352 passed |
| `@hobo/data-mongodb` | 106 passed, 31 skipped | 137 passed |
| `@hobo/trails` | 223 passed | 223 passed |
| `@hobo/events` | 95 passed | not part of the live command |

The live column is one run of `pnpm run test:data-live` with every test passing. The live totals
include each engine's kit runs against the reference engine in both directions and the cross-engine
files (`packages/data-postgres/test/cross-engine-live.test.ts`,
`packages/data-mongodb/test/cross-engine-live.test.ts`: SQLite ↔ PostgreSQL, SQLite ↔ MongoDB,
PostgreSQL ↔ MongoDB). Per-pair kit counts were not recorded separately for this run.

The native logical-copy proof is `packages/data-postgres/test/native-live.test.ts`, part of the
PostgreSQL live total: a dataset moves between two databases of one cluster under concurrent writers,
digest-equal, fenced, flipped once, nothing left behind. The figures it prints were last noted at
`85ae5267` (3398 records digest-equal after 488 concurrent transactions, 309 of which landed while
racing the fence) and were not noted again for this run. One run on one machine is a correctness
record, not a benchmark.

The intermittent live PostgreSQL failure seen at `85ae5267` has a root cause and a fix; see §10.

The kit earned its keep while it was being built. It caught the SQLite binding declaring strings
`exact` while storing text truncated at the first U+0000 — now refused and declared `constrained` — and
the engine work in turn caught the canonical model moving first-century dates to the twentieth
(`Date.UTC`'s two-digit-year rule) and digesting a lone surrogate ambiguously; both are fixed in
`@hobo/data-core`, with tests.

Beyond the kit: the selector, custody verdict, canonical model, and aggregate have their own tests;
the CUE constraints are vetted against real parser output; and each package's Pact contracts are
replayed against its code rather than merely kept on file.

## 10. Honest limits

Safety of the migration itself:

- **A late authority move is refused only by a router that implements the head rule** (§6). Every
  move carries the journal head of its decision, and `admitAuthorityMove` is the rule ready to call,
  but the router is the caller's. One that ignores `head` still lets a driver that won its cutover
  and stalled land the flip after a rollback. One driver per migration is still the operating rule.
- **`shiftReads` carries no head.** A late "reads go home" from a compensation can land after another
  driver's cutover. It moves reads, not writes.
- **A fence raised by someone else between a run's request and its raise is indistinguishable from
  the run's own.** The fence port reports no owner, so a run that died before journaling
  `migration.FenceRaised` adopts whatever fence it finds standing on its next attempt. Ownership is
  not checked at all in `log-pivot` and `stream-handoff`.
- **A decided cutover under a negative verdict still holds.** Only a rollback is exempt from the
  policy gate. A run that journaled `migration.CutOver`, crashed before the phase fact, and resumes
  under a negative verdict holds with the source fenced — and, if the flip had not landed, with the
  router still pointing at that fenced source, so no write is accepted — until the verdict clears.
- **An in-place phase with no probe trusts a throw.** A first-attempt `applyPhase` that throws is
  read as "not in effect" and answered by the restore. A port whose call committed and *then* threw,
  in a plan with no probe for that phase, is restored over. Give every phase a probe.
- **An in-place phase whose outcome is unknown stops the migration until a person adds a probe**
  (`PHASE_OUTCOME_UNKNOWN`), and a re-applied phase that fails stops it for a person
  (`PHASE_REAPPLY_FAILED`). Neither is resolved automatically; that is the price of never restoring a
  snapshot over writes made since.
- **A crash under the fence leaves the source fenced until the executor is run again.** Nothing
  releases a fence on a timer. Between the crash and the next run neither side accepts writes: the
  safe outcome, and an outage for as long as nobody re-runs the migration.
- **A lossless rollback needs the target to answer.** With a reverse tail and a dead target the
  rollback fails and authority stays where it is. The `@hobo/data-core` README suggests running the
  rollback with a target binding that hides `capture`, which makes the posture `to-snapshot`; no test
  exercises that.
- **`offline-copy` cannot recover from a failed verification if the source deletes a record before
  the retry.** A failed verification releases the fence and holds; the next attempt copies again but
  only upserts, so a record deleted on the source in between stays on the target and the comparison
  fails again until it is removed by hand.
- **The fence token is kept where `raise` can answer it.** Every engine stores the token in its own
  metadata, in the clear, because raising a raised fence must return it (§4). The journal no longer
  holds it, but the store does: on PostgreSQL the table's owner, a superuser, or a role granted the
  fence table can read it; on SQLite and MongoDB anything that can open the store can.
- **An engine whose fence does not survive a restart cannot resume a cutover.** The resumed run asks
  the store for the fence the decision was made under and holds when it is gone.
- **There is no transaction across source and target.** Convergence is bounded lag plus a fence. The
  flip is brief, not zero-duration.
- **Two of three fences are entry-point fences.** SQLite and MongoDB stop writers that go through the
  binding. A process with its own connection is not stopped. PostgreSQL's is enforced by the store —
  by a trigger, which a table owner or superuser can still disable.
- **`fence.raise` on PostgreSQL waits for writers in flight, and the wait is not bounded by a test.**
  A writer that keeps its transaction open keeps `raise` waiting until it ends, and the fix pass
  recorded that under sustained writers new writers do not queue behind the fence's update, so the
  wait can be longer than one write.

The native path (`migration.postgres.logical-copy/v1`):

- **What it can move.** One engine; a whole dataset, not one tenant of a pooled table; into an empty
  table of the same namespace and dataset name in a *different* database. Anything else is refused by
  name (`NATIVE_TRANSFER_REFUSED`). It realizes `snapshot-and-tail` only: no engine package declares
  a native `offline-copy`, and the executor path for one is tested on the reference engine alone.
- **What it needs.** `wal_level=logical`; a free replication slot and sender on the source; a free
  logical-replication worker on the target; a target role allowed to create subscriptions.
- **No reverse tail**, so the soak rollback is `to-snapshot`.
- **The target server holds the source connection string** in `pg_subscription` until the cutover
  drops the subscription. Its superusers can read it. To keep it out of the server's statement log,
  the subscribing transaction turns parameter and statement logging off for itself first; a role that
  may not do that, on a server that logs statements, is refused (`NATIVE_TRANSFER_REFUSED`, reason
  `CONNECTION_WOULD_BE_LOGGED`) rather than logged. An extension that logs parameters by its own
  settings, such as pgaudit, is outside what the binding can see.
- **A held native run is paused, except in the three "working" holds** (§6). While the initial copy
  has not finished or the lag is not yet within bound, the transfer keeps delivering through the
  hold, under the verdict it started with. A verdict that turns negative during those holds does not
  stop it until the run is next driven far enough to hold for the verdict itself.
- **A failed native run keeps its transfer**, because that is what lets it resume. Abandoning it
  takes one `nativeTransfer.stop` on each side under `nativeTransferName(migrationId)`.
- **A stuck apply worker shows only as a hold.** The executor asks a bounded number of times whether
  the copy has caught up and then holds; it does not diagnose why the engine is behind.
- **An unreachable source at `stop` can leave a slot behind** on the source from an unfinished
  initial copy.
- **Not tested:** two separate clusters (the live proof uses two databases of one cluster);
  PostgreSQL versions other than 16.15; a subscription owner that is not a superuser; an initial copy
  longer than the poll budget on a real server; the unreachable-source cleanup against a real server;
  open-schema datasets natively; a network failure mid-copy; a native `offline-copy` on a real engine.

What crosses, and what does not:

- **Cross-paradigm movement of an authoritative store still needs an authored model.** `log-pivot`
  makes it reviewable and replayable; it does not make it automatic. And it compares digests only when
  the sink keeps the source's schema — a genuine re-model changes the records, and the evidence is then
  positional.
- **The hub carries canonical records and nothing else.** Sequences, triggers, stored procedures,
  secondary indexes, foreign keys, and server-side functions do not cross it. A dataset provisioned
  through the hub has a primary key and typed columns.
- **`stream-handoff` re-mints event identity.** The event-store port has no identity-preserving
  import, so a handed-off event keeps its stream, sequence, type, version, payload, actor, and tenant,
  and is given a new id and timestamp; the originals travel in `meta.handoff`. Every handoff reports
  `HANDOFF_EVENT_IDENTITY_REMINTED`.
- **Ill-formed values are refused by the model.** A lone surrogate, a non-finite number, an
  `encrypted` value with an extra member, and an instant with no offset are refused for every engine
  rather than stored altered (§4).

Engines:

- **MongoDB needs a replica set.** Not only for change streams: atomic `write`, `apply`, and `retire`
  are multi-document transactions, which a standalone server does not have. The binding refuses
  rather than degrade.
- **The PostgreSQL schema snapshot is a table copy in the same database.** It refuses tables with
  foreign keys, triggers, identity columns, row security, partitions, or inheritance, a table owned by
  another role, and a table in a publication, rather than restore them unfaithfully. A
  `FOR ALL TABLES` publication on a shared server therefore makes every schema snapshot refuse.
- **PostgreSQL writes are one statement per record.** There is no write batching in the PostgreSQL
  binding yet. One MongoDB transaction bounds one atomic unit, so a very large batch is refused rather
  than split.
- **A SQLite dual-run port pins the source journal for as long as it exists.** It keeps its own
  cursor and never acknowledges, so the source journal grows for the life of the pin.
- **The schema IR is still single-dialect.** `SchemaIr.dialect` remains `"postgres"`
  ([ADR-0160](./adr/03-data-plane.md#adr-0160)). Cross-engine provisioning does not use it — each
  engine's `datasets` port emits its own DDL from the canonical dataset schema — but a declarative
  *diff* for another dialect does not exist. `in-place-evolve` statements for SQLite are authored.
- **MySQL and SQL Server are not implemented.** The contract is the same one; the work is a binding,
  an annex, and a passing report. They are candidates for generated adapters certified through the
  existing pipeline ([ADR-0010](./adr/03-data-plane.md#adr-0010)).
- **Vector and graph sinks have no within-class guarantee**
  ([ADR-0081](./adr/03-data-plane.md#adr-0081) §2). They move by `rebuild-and-swap`; re-embedding is
  non-deterministic, so verification would be by id set and count, not by vector equality.
- **Multi-region active-active is out of scope** — an
  [ADR-0040](./adr/01-architecture-core.md#adr-0040) topology concern, not a migration pattern.

Evidence:

- **The live PostgreSQL and MongoDB lanes run in CI where a diff can reach them — not on every push,
  and not on a schedule.** The `Live data engines` job in `.github/workflows/hobo-ci.yml` starts a
  digest-pinned PostgreSQL 16 and a one-member MongoDB 8 replica set as sibling containers
  (`scripts/ci/data-live-servers.mts`) and runs `pnpm run test:data-live` against them. It runs on a
  pull request when `scripts/ci/job-scope.mts` finds that the diff reaches the live suites — the data
  packages, `@hobo/trails`, anything they import, or CI configuration — and on a manual dispatch.
  A green run is checked, not assumed: the job fails unless each of the five packages reported and
  no test was skipped, since a live test without its server skips rather than fails.
  What that leaves open: it does not run in the merge queue; it blocks a merge only if the branch
  ruleset names it as a required check, which is a repository setting, not something this change can
  set; nothing runs the suites against a change whose diff does not reach them, short of a manual
  dispatch; it covers
  the two pinned server versions only; and it has so far run only on GitHub-hosted runners, not on
  the self-hosted fleet, where the job is a container beside the two servers. The always-on lanes cover the contract logic, the decoder
  against recorded bytes, MongoDB over its in-memory executor, and SQLite for real.
- **The intermittent live PostgreSQL failure seen at `85ae5267` is explained and fixed; a residual
  remains.** Root cause: a logical replication slot created while another session creates a table and
  writes to it can be poisoned — every decode from it then fails with SQLSTATE `XX000`, "could not
  map filenumber … to relation OID", for good, because each read replays the same log. Before the
  fix 1 of 25 serial runs of the live lane failed, and 6 of 30 with two runs in parallel. The fix: a
  slot is **proven decodable before use**. `capture.start`, and a native `publish`, wait (bounded)
  for the transactions open at the slot's consistent point to end, decode once, and on exactly that
  failure drop the slot and create another, up to five times; failing that, `CAPTURE_SLOT_UNPROVEN`
  and nothing is left started. After the fix 25 of 25 serial runs passed. Tests:
  `packages/data-postgres/test/engine-slot-proof.test.ts` offline, and a deterministic regression in
  `engine-hardening-live.test.ts`. **Residual:** the slots PostgreSQL itself creates for a native
  subscription's initial table sync can be poisoned the same way, and the binding does not control
  their creation.
- **Test files are outside the type-check gate.** Each package's `tsconfig.json` includes `src`
  only, so a type error in a test file does not fail `typecheck`; the fix pass recorded several.
- **The boundary gate's driver rule is a list.** It names the drivers of the three engines and the
  ones the workspace already resolves; a driver that is not on the list passes until it is added.
- **The kit's crash windows do not model a process restart** (§9). A resumed run reuses the binding
  objects of the run that was killed. The kit injects crashes for `snapshot-and-tail` only (hub and
  native cutover; hub compensation and rollback); the other patterns' windows, the two-driver
  scenarios, and the in-place probe paths are proven on the reference engine.

## 11. Decisions that were open, and how they were settled

- **The common package's name: `@hobo/data-core`.** `-core` is the conventional name for the base a
  package family derives from, and the alternative — a subpath of `@hobo/data` — would have put engine
  authors and app authors on one import site and carried the SQLite storage dependency into every
  engine (§3).
- **`log-pivot` is in the catalog.** A closed catalog with a missing cell is worse than one whose
  one-way door is labelled. Leaving it out would have made cross-paradigm movement of an authoritative
  store unrepresentable, and something unrepresentable gets done by hand.
- **Engines: SQLite, PostgreSQL, MongoDB.** These are the three the data plane already names as core —
  the native default, the relational reference, and the document reference
  ([data-plane §Paradigm taxonomy](./data-plane.md#paradigm-taxonomy-for-projection-sinks)) — and
  between them they exercise an embedded engine, a server with store-enforced fencing and log-based
  capture, and a different paradigm.
- **`pg_dump` is not declared as a native realization.** A declared native profile is a promise that
  the binding's `nativeTransfer` port can run it: the selector may then choose it and an executor must
  be able to carry it out. Running `pg_dump` takes a process runner, and `@hobo/data-postgres` has
  none — it has an injected SQL executor. Declaring the profile anyway is how a decision comes to say
  `native` while nothing can execute it, which is the defect `assertBindingMatchesDeclaration` now
  refuses. So `migration.postgres.pg-dump/v1` stays a migration profile with argument builders, and
  the binding declares only `migration.postgres.logical-copy/v1`, and only when it has capture.
- **A native realization runs through a port, with no fallback.** The alternative — the executor
  quietly running the hub when the native path is unavailable — would carry out a plan other than the
  one that was decided and recorded. An unavailable native path is an error.
- **The fence token is journaled as a digest.** The alternative that keeps the token out of the
  journal *and* out of the store does not exist under an idempotent `raise`; the choice made is to
  keep one custody point (the engine's metadata) instead of two.
- **An authority move carries the journal head of its decision, and the router compares-and-sets on
  it.** A fact in front of a side effect stops a driver whose view is stale; it cannot stop one that
  won the fact and stalled inside the router call. The alternatives were a lease on the migration —
  a second coordination mechanism beside the journal — or accepting the late flip. The journal
  already totally orders decisions, so its head is the fencing number, and the router is the one
  place that can refuse.
- **An in-place phase with an unknown outcome is probed, never re-applied on a guess and never
  restored.** Re-applying fails for any statement that is not repeatable, and answering that failure
  with a snapshot restore discards every write the application made since the first attempt. So the
  plan carries a probe per phase, and without one the run holds for a person.
- **A rollback is not held by policy.** A negative verdict objects to where data is; a rollback out
  of the soak window moves authority back to where the data already was. Holding a decided rollback
  would leave both stores fenced, so it finishes regardless, and a requested one records the findings
  it ran under.
- **A held native transfer is paused, except while the engine is still doing approved work.** Pausing
  PostgreSQL's unfinished initial copy restarts it on re-enable, so pausing on every bounded-wait
  hold would never let a large copy finish.
