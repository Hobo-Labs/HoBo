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
delegates to `runInPlaceEvolve` in `@hobo/data-core`. A run that succeeds emits the fact sequence the
original executor did (`packages/data-core/test/migration-run.test.ts`). A run that fails does not
behave as before: a restore now has its decision journaled first, and without an erasure replay it
does not restore at all (§8).

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
- **In-place phases are not write-ahead.** The fact for `expand`, `backfill`, or `contract` is
  appended *after* the phase's statements ran. A crash between the two re-applies that phase on
  resume. If its statements are not repeatable the phase fails, and the run restores the first
  snapshot (or holds, when no erasure replay is wired). The restore itself *is* decided first.

## 4. The engine contract

An engine package ships: a binding that implements the SPI; a declaration that states the engine's
real limits; a type-mapping annex; a closed list of impedance codes
([ADR-0144](./adr/07-portability-extensibility.md#adr-0144)); and a conformance report.

| Port | Contract |
|---|---|
| `datasets` | create a dataset from a canonical schema, idempotently and additively; describe it |
| `records` | the single write entry point (atomic, fence-aware), and point reads |
| `snapshot` | scan a scope in chunks; may be fuzzy |
| `capture` | ordered changes strictly after a position; durable, resumable, non-consuming; `start` is idempotent and returns the original position; a batch never splits a source transaction and may exceed its limit to keep one whole; a position the engine did not issue is an error, never an empty batch |
| `apply` | apply changes and record the watermark in one transaction; idempotent under redelivery. With `expectedWatermark` the apply is **conditional**: the batch lands only if the watermark recorded for its source is exactly the one named (`null` meaning none yet), the comparison and the write are one transaction, and anything else is refused with `StaleApplyError` (`STALE_APPLY`) with neither a record nor the watermark changed. Without the member the apply is unconditional |
| `verify` | counts and bucketed digests for a scope — a record never crosses this port |
| `fence` | raise a write fence and get its token; a fenced writer is refused unless it presents the token; `release` needs the token; `raise` returns only once no write that began before it can still land. **`raise` on a raised fence returns the existing token** — see below for what that makes the token |
| `retire` | destructive removal; refused without the raised fence's token and a still-matching digest. Whether a redelivered `retire` succeeds differs by engine (table below) |
| `schema` | expand / backfill / contract statements, a restorable snapshot, a violations query |
| `nativeTransfer` | the engine's own bulk transport for a declared native profile: `publish`, `subscribe`, `seeded`, `mark`, `reached`, `stop` — it replaces only seed and converge |

`datasets` and `records` are mandatory. For the rest, **absence is a declaration**: a port an engine
cannot provide makes the patterns that need it ineligible in §7, by name.
`assertBindingMatchesDeclaration` refuses a binding that provides a port it does not declare or
declares one it does not provide, and the same in both directions for native profiles.

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
| Capture log retention | a journal row is kept only while some subscription has yet to acknowledge it; with no subscription the journal is empty; `retire` deletes the scope's journal rows with its records | the slot pins write-ahead log until it is acknowledged or stopped | none of its own — the oplog window; `acknowledge` is a no-op |
| Capture ordering | global | global, in commit order | global |
| Fence enforcement | `entry-point` — stops writers through the binding, not another process on the file | `store` — a `SECURITY DEFINER` trigger with a pinned search path refuses any session without the token; the table owner, a superuser, or a role granted the fence table can still get past it | `entry-point` — MongoDB has no triggers |
| Redelivered `retire` | refused if it names the original digest (the scope no longer matches it); a caller re-digests | the same | answers `removed: 0` when the scope is already empty behind the same token (`packages/data-mongodb/test/live.test.ts`) |
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
subscription. `pg_dump` stays a migration profile with its argument builders, but the binding cannot
run a process, so it is not declared as a native realization (§11). A native run has no reverse tail,
so its soak rollback is `to-snapshot` (§5, §7).

The envelope stream is a transport channel, **not** event-log facts: payload in the log would make the
log a custody point for data in flight. What the journal records is positions, watermarks, counts,
digests, and — for a native run — the transfer's name and its ticket, which by the port's contract
carries no credential and no record. It records a digest of the fence token, never the token (§6).
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

Two drivers of one migration are therefore excluded in two ways
(`packages/data-core/test/two-drivers.test.ts`):

- **A fact comes before every side effect that moves or releases write authority**, so the driver
  whose view is out of date loses its next append and stops before it acts.

  | Before | the run journals |
  |---|---|
  | a write fence is raised (the source at the cutover, the target at a rollback) | `migration.FenceRequested` |
  | a fence is released because verification under it failed | `migration.Held`, with `compensated: true` |
  | write authority moves to the target | `migration.CutOver` |
  | write authority moves back to the source | `migration.RollbackDecided` |
  | an in-place store is restored from its snapshot | `migration.RollbackDecided` |

- **A stale applier is refused by the store.** Every batch a copy executor applies is conditional on
  the leg's watermark (§4), and that watermark is stored as `<journalHead>@<position>` — the journal
  head of the driver that wrote it. Before anything is compared under a fence, the cutting-over
  driver stamps its own head on the leg; a driver with an older view then names a watermark that is
  gone, and one that reads the leg afresh sees a head newer than its own. The event-log executors
  apply conditionally too.

A driver that meets either refusal has been superseded: it records nothing further, compensates
nothing, and rethrows.

**The residual, stated plainly.** A driver that *wins* a fact and then stalls before the side effect
that fact authorizes, while another run finishes the step and moves on, still performs that one side
effect late. `flipAuthority` and `fence.release` belong to the caller and the engine and take no
journal head to be refused by. Run one driver per migration; the compare-and-set is a safety net, not
a lease.

### What resume does at each crash window

Tested in `packages/data-core/test/crash-windows.test.ts`, which injects a failure at each side
effect of the forward path, a compensation, and a rollback, for both realizations.

| The run stopped | The next run |
|---|---|
| inside a phase before the flip, no decision journaled | runs that phase again from its start. A seed re-applies idempotently and conditionally; a fence already raised answers its token again |
| under the source's fence, before the cutover was decided or the fence released — including after a compensation's hold was journaled | finds the source still fenced: it has refused writes since the crash and keeps refusing them until this run. Re-entering the step raises the same fence, verifies again, and either flips or compensates |
| after `migration.CutOver`, before or after `flipAuthority`, before the phase fact | **finishes the move**: asks the store whether the fence is up, gets the token back by raising it, checks it against the journaled digest, and calls `flipAuthority` again (it must be idempotent). It never re-verifies against a target that has since taken writes |
| …and the fence is down, or is not the one the decision was made under | holds for a person. It neither flips nor puts a fresh fence on a store that may be the authority |
| after a target fence was requested for a rollback, before any decision | if it is not going to roll back: journals a hold, releases the target's fence, and stops, so the new authority is not left refusing writes |
| after `migration.RollbackDecided`, anywhere before `migration.RolledBack` | **finishes handing authority back**; `soakDecision` is not asked again. The source's fence is released last, so finding it down means only the record is missing |
| after the source's `retire` committed, before the `finalize` fact | finds the scope empty behind the migration's own fence and completes, instead of mistaking it for a source that changed |

`completed` and `rolled-back` **absorb**: the fold ignores any fact appended after either, and a
finished migration run again is a no-op, not a second cutover.

### The migration is an aggregate

An executor emits `migration.*` facts; the state is `foldMigration` over them.
`MIGRATION_FACT_VERSIONS` is the version each fact body is journaled at, the bodies are pinned in
`@hobo/events` (`packages/events/src/upcaster-corpus.ts`), and
`packages/events/test/migration-fact-contracts.test.ts` runs every executor and validates each fact
it emits against the current pinned version.

| Fact | Version | Body, and what changed |
|---|---|---|
| `migration.Planned` | 2 | `phases` is a list (v1 pinned one comma-joined string). Optional: `pattern`, `realization`, `profile`, `decisionDigest`, `custodyDigest`, `source`, `target`, `dataset`. Upcaster splits the string |
| `migration.SnapshotTaken` | 1 | unchanged |
| `migration.PhaseApplied` | 2 | `statements` is no longer required; `checkpoint` added — a uniform-model phase records positions, counts and digests, not statements |
| `migration.Verified` | 1 | optional additions: `count`, `digest`, `compared` |
| `migration.FenceRequested` | 1 | **new.** `migrationId`, `side` (`source` or `target`), `phase`, `requestedAt` |
| `migration.CutOver` | 2 | `fenceToken` withdrawn, `fenceTokenDigest` and `fencedFrom` added; `count`, `digest`, `reverseTail`, `reversePosition`, `authority`, `logPosition` modelled. Upcaster digests a v1 token and drops it |
| `migration.Held` | 1 | optional additions: `compensated`, `before` |
| `migration.Resumed` | 1 | unchanged |
| `migration.RollbackDecided` | 1 | **new.** `migrationId`, `lossless`, `decidedAt`; optional `erasuresFrom`, `count`, `digest` |
| `migration.RolledBack` | 2 | `snapshotRef` is no longer required (a copy pattern rolls back to the old store, not to a snapshot); `lossless`, `erasuresReplayed` added |
| `migration.Completed` | 1 | unchanged |
| `migration.Failed` | 1 | unchanged body; `reason` is now a class name plus a stable code (below) |

`migration.Exported` and `migration.Imported` belong to the same family and are not emitted by these
executors. `in-place-evolve` ends a successful run with `migration.CutOver`, as the original executor
did, not with `migration.Completed`.

**The journal carries a digest of the fence token, never the token.** A fence token lets its holder
write through the fence and retire the source; a journal is evidence, read by people and systems that
must not gain that. `migration.CutOver` and the `fence-and-flip` checkpoint record
`fenceTokenDigest` (`sha256:` of the token). A later phase or a resumed run asks the store again —
raising a raised fence answers its token — and holds if the digest no longer matches. The kit asserts
that no fact carries the token. A journal written before this change still resumes: the executors
read a v1 token where one is present, and the journal does not rewrite stored events.

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
carries a **custody path**: every place the data rests or passes — source, target, event log, staging
artifacts, the runner that relays rows, capture logs, the rollback snapshot, the retiring source —
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
| **Single write authority** | a fenced writer is refused; authority flips once; a second driver is excluded (§6) | the `fence` port; the conditional `apply`; the journal's compare-and-set |

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
runs. Before the flip the source stays the writable authority; after it the target is. When the
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
- `in-place-evolve` needs `replayErasures` to restore. Without it a failed phase holds and the store
  is left as it is.
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
`NATIVE_CONFORMANCE_CASE_IDS` the subset that proves a native realization; the kit is extended as
defects are found, so this section describes what it proves and leaves the count to the dated table
below.

| Group | What a pass proves |
|---|---|
| Declaration | the binding provides exactly the ports and native profiles it declares |
| Datasets and records | provisioning is idempotent and describable; every canonical type reads back byte-identical; the same key in two tenants is two records; a write whose key disagrees with its record's key is refused and leaves nothing; an undeclared open-schema field survives, one named `__proto__` included; a dataset named after the engine's own bookkeeping is refused or harmless |
| Type mapping | a value at the edge of what the engine can hold round-trips exactly or is refused — never stored altered; a first-century timestamp round-trips or is refused when written, never accepted and then unreadable |
| Apply | re-applying a batch changes nothing; the watermark is recorded and an empty batch advances it; a conditional apply that names a stale watermark is refused and changes nothing, and of two appliers naming the same watermark exactly one lands |
| Verify and snapshot | the engine's digest equals the canonical digest of the same records and carries no payload; a scan returns every record in scope once, within its tenant |
| Capture | changes arrive in commit order, strictly after the start, non-consuming, with an idempotent start; a scoped subscription sees only its tenant; an update of a record with a very large key is captured under that key; a position the engine never minted is an error, not an empty batch |
| Fence and retire | raising a raised fence returns its token; a fenced write is refused with `FencedWriteError` and the token writes through; only the token releases; writes racing `raise` either land before it returns or are refused; retire is refused without the fence and with a stale digest, and removes exactly its scope |
| `snapshot-and-tail` through the hub | zero loss with writes arriving between phases and authority moving once; resume to completion after a crash following each phase's fact; a write made after the flip survives a rollback under a reverse tail; without one the posture is `to-snapshot`, the loss is stated, and an erased subject stays erased; one tenant leaves a pooled store and the other is untouched; no fact carries a record or the fence token |
| `snapshot-and-tail`, native | the same zero-loss and resume properties with the engine carrying the records and writers racing the fence; the journal records the realization; retiring the source does not reach the target through the engine's transport |
| `offline-copy` | a fenced copy arrives complete and the source is retired |
| `in-place-evolve` | a consumer on the old shape blocks the destructive phase and keeps the dual window open; a failed phase restores the snapshot and re-applies erasures, and the same plan then completes |

**What the kit does not inject (at `85ae5267`).** Its resume cases crash a run *after* a phase's fact
is journaled. The crash windows inside a phase, the two-driver scenarios, the compensation and rollback paths, and
the event-log patterns are proven against the reference engine by `@hobo/data-core`'s own tests
(`crash-windows.test.ts`, `two-drivers.test.ts`, `executor-findings.test.ts`,
`native-realization.test.ts`, `event-log-executors.test.ts`), not per engine by the kit.

The fold is pessimistic. A failure is `fail`; a case that applies but could not run is `not-run`,
which makes the outcome `unknown`; and `unknown` is as non-selectable as `fail`. A case whose port the
engine does not declare is skipped — not forgiven: the pattern needing that port is ineligible at
selection. A native case is skipped the same way when engine and peer share no native profile.

What runs where:

| Lane | Runs in the default test lane | What it exercises |
|---|---|---|
| Reference engine, same- and cross-engine | yes | the kit itself, and every executor |
| SQLite ↔ SQLite, SQLite ↔ reference (both directions) | yes | the kit against real files, including `in-place-evolve` over real DDL |
| Event-log patterns on the real SQLite event store + SQLite engines | yes (`packages/trails/test/data-patterns-e2e.test.ts`) | `rebuild-and-swap`, `log-pivot`, `stream-handoff` on disk; the migration journal on the event store |
| MongoDB over its in-memory executor | yes | the binding's logic without a server; the executor interleaves transactions, so the fence race case can fail offline |
| PostgreSQL, live | opt-in: `HOBO_TEST_POSTGRES_URL` | the kit against a real server, including logical-decoding capture and the native logical-copy cases |
| MongoDB, live | opt-in: `HOBO_TEST_MONGODB_URL` | the kit against a real replica set, including change streams |
| Cross-engine among SQLite, PostgreSQL, and MongoDB, live | opt-in: both variables | real records moving between real engines of different paradigms |

To run the live lanes locally, start the two servers from the compose file and run the one command
(details in [live-provider-matrix](./live-provider-matrix.md#data-engines-packagesdata--adr-0177)):

```bash
docker compose -f packages/data-core/deploy/compose.live-engines.yml up -d --wait
pnpm run test:data-live
```

### Last recorded run

**Recorded 2026-11-10 at commit `85ae5267`.** PostgreSQL 16.15 with `wal_level=logical`, MongoDB
8.0.4 single-node replica set. The kit is being extended; when it changes, this table and the two
lines under it are the only numbers in this section to refresh.

Kit size at this commit: **30** case ids, of which 2 are native cases.

| Kit run | Outcome | Skipped |
|---|---|---|
| PostgreSQL ↔ PostgreSQL, live | `pass` — every case | none |
| SQLite ↔ SQLite | `pass` — every case that applies | the 2 native cases (SQLite declares no native profile) |
| MongoDB ↔ MongoDB | `pass` — every case that applies | the 2 native cases and the 2 `schema` cases (MongoDB declares neither) |

| Package | Tests, default lane | Tests, live lane |
|---|---|---|
| `@hobo/data-core` | 205 passed | — |
| `@hobo/data-sqlite` | 37 passed | — |
| `@hobo/data-postgres` | 293 passed, 38 skipped | 331 passed |
| `@hobo/data-mongodb` | 105 passed, 31 skipped | 136 passed |
| `@hobo/trails` | 221 passed | — |
| `@hobo/events` | 91 passed | — |

The live totals include each engine's kit runs against the reference engine in both directions and
the cross-engine files (`packages/data-postgres/test/cross-engine-live.test.ts`,
`packages/data-mongodb/test/cross-engine-live.test.ts`: SQLite ↔ PostgreSQL, SQLite ↔ MongoDB,
PostgreSQL ↔ MongoDB). Per-pair kit counts were not recorded separately for this run.

The native logical-copy proof (`packages/data-postgres/test/native-live.test.ts`) recorded, in the
same run: 3398 records digest-equal after 488 concurrent transactions, 309 of which landed while
racing the fence; plan to cutover in 781 ms. That is one run on one machine, between two databases of
one cluster — a correctness record, not a benchmark.

An intermittent failure seen in this run is listed in §10.

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

- **A driver that wins a fact and then stalls performs one side effect late** (§6). The journal's
  compare-and-set stops a driver whose view is out of date *before* it acts; it cannot recall a
  `flipAuthority` or a `fence.release` from a driver that already won the fact and paused. One driver
  per migration is still the operating rule.
- **In-place phases are not write-ahead** (§3). A crash between a phase's statements and its fact
  re-applies that phase on resume.
- **A crash under the fence leaves the source fenced until the executor is run again.** Nothing
  releases a fence on a timer. Between the crash and the next run neither side accepts writes: the
  safe outcome, and an outage for as long as nobody re-runs the migration.
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
  drops the subscription. Its superusers can read it.
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

- **The live PostgreSQL and MongoDB lanes are opt-in and not in CI.** They need a server, no workflow
  provides one, and nothing sets the two variables there. A regression in live capture, in the fence
  under real concurrency, or in the native path is caught by whoever runs `pnpm run test:data-live`,
  not by every push. The always-on lanes cover the contract logic, the decoder against recorded
  bytes, MongoDB over its in-memory executor, and SQLite for real.
- **An intermittent live PostgreSQL failure is unexplained.** In the run recorded in §9 it was
  observed 3 times within a few minutes — twice the hub kit case
  `pattern.snapshot-and-tail.resumes-at-every-boundary` threw a raw driver error, and once the native
  live file held at `prepare` instead of reaching soak, failing the assertions that depended on it —
  and it was not reproduced in about 20 later runs. The cause is not known. Until it is, a green live
  run is evidence, not a guarantee.
- **Test files are outside the type-check gate.** Each package's `tsconfig.json` includes `src`
  only, so a type error in a test file does not fail `typecheck`; the fix pass recorded several.
- **The boundary gate's driver rule is a list.** It names the drivers of the three engines and the
  ones the workspace already resolves; a driver that is not on the list passes until it is added.
- **At `85ae5267` the kit proves an engine against the ports and the patterns; it does not inject a
  crash inside a phase per engine** (§9). Those windows are proven on the reference engine.

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
