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

## 1. What was wrong, and what changed

Most of the concepts already existed — expand/backfill/contract, snapshots, CDC duals, migration
profiles, the residency evaluator, the Trail runner. What was missing was the seam between them.

| Finding before | What changed |
|---|---|
| Engine code lived inside the orchestrator: `@hobo/trails` imported `node:sqlite` for its schema-apply and dual-run ports, so a second engine would have been added *to the runbook engine* | The SQLite bindings moved to `@hobo/data-sqlite`. `@hobo/trails` keeps port shapes only. The package-boundary gate refuses, from an orchestrator's `src/`, any import of a `@hobo/data-<engine>` package, a database driver (`node:sqlite`, `pg`, `mongodb`, …), or engine-specific storage — static, dynamic, or `require` — and refuses one engine importing another. Test-only edges are allowed |
| No shared engine contract: `@hobo/data-postgres` owned a profile, a conformance suite, and migration profiles, but implemented none of the ports Trails executes | `@hobo/data-core` defines one SPI. SQLite, PostgreSQL, and MongoDB implement it and pass one conformance kit |
| The migration pattern was an untyped mode string (`"bulk" \| "delta" \| "cdc-dual"`) with no record of why it was chosen | A closed pattern catalog and a pure selector whose decision — every candidate, every reason — is a digested record |
| Policy inputs were asserted: `CanTrailInput.residencyConflict?: boolean`, `policyAllows?: boolean` | A verdict computed over a custody path — every place the data rests or passes — and recomputed before every phase. `can-trail` takes it alongside the booleans: any one of them denying denies the trail, and a malformed verdict is a denial |
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
  ├─ engine SPI            the nine ports in §4, and the engine declaration
  ├─ type-mapping annex    per-engine fidelity, composed across engines
  ├─ pattern catalog       the six continuous-migration patterns in §5
  ├─ pattern selector      pure, deterministic: hard gates then lexicographic order (§7)
  ├─ policy verdict        custody path → computed residency / protection / retention verdict (§8)
  ├─ pattern executors     the six patterns, run over the ports, resumable, policy-gated per phase
  ├─ migration aggregate   migration.* facts, their fold, an event-store journal
  ├─ conformance kit       the one suite every engine must pass (§9)
  └─ reference engine      in-memory, complete: the executable definition of each port

@hobo/data-sqlite          SQLite over node:sqlite — and the sync ports Trails' live lanes run on
@hobo/data-postgres        PostgreSQL over an injected executor; logical-decoding capture; no driver dependency
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

**One implementation of expand → backfill → contract.** `executeDataMigration` in `@hobo/trails` now
delegates to `runInPlaceEvolve` in `@hobo/data-core`; the fact sequence is unchanged for existing
callers.

## 4. The engine contract

An engine package ships: a binding that implements the SPI; a declaration that states the engine's
real limits; a type-mapping annex; a closed list of impedance codes
([ADR-0144](./adr/07-portability-extensibility.md#adr-0144)); and a passing conformance report.

| Port | Contract |
|---|---|
| `datasets` | create a dataset from a canonical schema, idempotently and additively; describe it |
| `records` | the single write entry point (atomic, fence-aware), and point reads |
| `snapshot` | scan a scope in chunks; may be fuzzy |
| `capture` | ordered changes strictly after a position; durable, resumable, non-consuming; `start` is idempotent and returns the original position; a batch never splits a source transaction and may exceed its limit to keep one whole; a position the engine did not issue is an error, never an empty batch |
| `apply` | apply changes and record the watermark in one transaction; idempotent under redelivery |
| `verify` | counts and bucketed digests for a scope — a record never crosses this port |
| `fence` | raise a write fence with a token; a fenced writer is refused; only the token holder releases |
| `retire` | destructive removal; refused without the raised fence's token and a still-matching digest |
| `schema` | expand / backfill / contract statements, a restorable snapshot, a violations query |
| `nativeTransfer` | the engine's own bulk transport for a declared native profile: `publish`, `subscribe`, `seeded`, `mark`, `reached`, `stop` — it replaces only seed and converge |

`datasets` and `records` are mandatory. For the rest, **absence is a declaration**: a port an engine
cannot provide makes the patterns that need it ineligible in §7, by name.
`assertBindingMatchesDeclaration` refuses a binding that provides a port it does not declare or
declares one it does not provide, and the same in both directions for native profiles.

What the three engines declare:

| | SQLite | PostgreSQL | MongoDB |
|---|---|---|---|
| Change capture | transactional outbox, journaled with the write; a row is kept only while a subscription is owed it | logical decoding (`pgoutput`) through a replication slot | change streams over a collection with change images enabled (needs a replica set) |
| Capture ordering | global | global, in commit order | global |
| Fence enforcement | `entry-point` — stops writers through the binding, not another process on the file | `store` — a `SECURITY DEFINER` trigger with a pinned search path refuses any session without the token; the table owner, a superuser, or a role granted the fence table can still get past it | `entry-point` — MongoDB has no triggers |
| Snapshot | fuzzy | fuzzy | fuzzy |
| DDL transactional | yes | yes | no |
| `schema` port | yes, for a file-backed store | yes | no — there is no SQL surface |
| Native fast path | none | `migration.postgres.logical-copy/v1` — a whole dataset, between two databases | none |
| Driver dependency at runtime | `node:sqlite` (built in) | none — an injected executor | none — an injected executor |

**The canonical model is the hub.** A dataset schema gives each field a canonical type (`bool`,
`int64`, `float64`, `decimal`, `string`, `bytes`, `timestamp`, `date`, `uuid`, `json`, `encrypted`),
and a canonical record holds each value in the *one* normal form its type allows — an `int64` as a
decimal string, a `timestamp` as UTC with exactly six fractional digits, a `decimal` with no leading
or trailing zeros. Every engine captures into `ChangeEnvelope`s of canonical records and applies out
of them. That makes cross-engine movement **hub-and-spoke**: N engines cost N adapters, not N²
pairwise migrators, and a new engine is a source and target for every existing one the day it passes
conformance. Normal form is also what makes verification possible: two engines that store one value
differently must digest it to the same bytes.

A same-engine move may use the engine's **native fast path**, declared as a migration profile that
names the pattern it realizes and run through the `nativeTransfer` port. The engine moves the bytes;
the executor keeps everything that makes the move safe — phases, the policy verdict, digest
verification, the fence, the journaled cutover, soak. A run records the realization it used, a run
resumed under the other realization is refused, and there is no fallback from `native` to `hub`: an
unavailable native path is `NATIVE_REALIZATION_UNAVAILABLE`, not a quiet downgrade. PostgreSQL
implements `migration.postgres.logical-copy/v1` with a publication, a separately created slot, and a
subscription. `pg_dump` stays a migration profile with its argument builders, but the binding cannot
run a process, so it is not declared as a native realization. A native run has no reverse tail, so
its soak rollback is `to-snapshot`; the selector therefore ranks a hub run with a reverse tail above
it, and native wins only when chosen explicitly or when the hub cannot offer one.

The envelope stream is a transport channel, **not** event-log facts: payload in the log would make the
log a custody point for data in flight. Only positions, watermarks, counts, and digests are recorded.
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

A **reverse tail** is capture on the target plus apply on the source. After the flip the old side keeps
receiving the new side's writes, so a rollback loses nothing. Without both ports the old side goes
stale at the flip, and the executor reports `rollback: "to-snapshot"` rather than claiming otherwise.

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
policy. Naming it per phase is what makes a long-running migration pausable — by a policy change, a
budget breaker, or an operator — without anyone improvising. If exact verification under the fence
fails, the step compensates: reads go home, the fence is released, and the source remains the
authority.

**The cutover is decided before it is done.** Under the fence, once both sides digest equal, the
executor journals `migration.CutOver` and only then moves write authority. A crash between the two is
resumed by *finishing* the move — the flip is idempotent by contract — never by re-verifying against a
target that has since taken writes, failing, and releasing the source's fence into two writable stores.

**The migration is an aggregate.** An executor emits `migration.*` facts; the state is `foldMigration`
over them; and resuming after a crash or a hold is replaying that fold and continuing from the last
completed phase. A completed migration run again is a no-op, not a second cutover.
`createEventStoreMigrationJournal` appends the facts to the durable event store, one stream per
migration.

**Events.** No new family. `migration.*` ([event-families](./event-families.md)) gains
`migration.Held`, `migration.Resumed`, and `migration.Completed`, pinned in the golden-replay corpus
([upgrade-migration-engine](./upgrade-migration-engine.md) M4); `migration.Planned` carries the
pattern and, when supplied, the decision and custody digests; `migration.PhaseApplied` carries the
uniform phase name and its checkpoint. Every addition is an optional field, so the original
expand/backfill/contract bodies are unchanged. `migration.Failed` records an error's class name only —
a thrown message can carry a connection string.

## 7. Pattern selection is deterministic and recorded

Choosing a pattern is a Matching-class decision ([ADR-0033](./adr/01-architecture-core.md#adr-0033)):
`selectMigrationPattern` is a pure function — no clock, no I/O, no model on the path — and the same
inputs always produce the same digest.

**Hard gates, fail-closed:** the pattern is legal for this authority and change; both engines declare
the ports it needs; the composed type mapping has no un-waived `lossy` edge (and a cross-engine move
with no schema is *unverified*, not assumed exact); conformance evidence for every engine involved is
`pass` and fresh; the policy verdict passes; the write freeze fits the declared budget, where an
unestimated freeze is never treated as zero; and the soak rollback posture is at least what was
required.

**Then lexicographic order — never a weighted score**
([ADR-0151](./adr/07-portability-extensibility.md#adr-0151) §11): stronger rollback posture → less
write freeze → native realization over the hub → fewer custody points → lower estimated cost → stable
pattern id.

**No silent downgrade.** Every pattern in the catalog appears among the candidates. When nothing
survives, the decision names a reason for each — the same agent-correctable shape as
`deployment.PlanRejected` — instead of falling back to a pattern that needs downtime.

## 8. Policy holds for every intermediate state

A move that is compliant at both ends can still be non-compliant in the middle. A plan therefore
carries a **custody path**: every place the data rests or passes — source, target, event log, staging
artifacts, the runner that relays rows, capture logs, the rollback snapshot, the retiring source —
each with a region, the protections it provides, and for a bounded copy a retention deadline. The
verdict is *computed* from that path; nothing accepts a boolean.

| Invariant | Rule | Where it is enforced |
|---|---|---|
| **Residency at every custody point** | each point's region passes `evaluateResidency`; an unmapped region is a conflict | `evaluateCustodyPath`, over the `@hobo/core` jurisdiction port ([ADR-0146](./adr/02-identity-security.md#adr-0146)) |
| **No protection downgrade** | every point provides what the data's classification requires | `evaluateCustodyPath`; the requirement table is an input, so a policy pack can tighten it |
| **Bounded copies** | every non-permanent point has a retention deadline, and none has outlived it | `evaluateCustodyPath`, evaluated against the injected instant |
| **Erasure continuity** | `encrypted` fields move as ciphertext and are never decrypted in flight | the canonical model; the kit's round-trip case |
| **No resurrection** | a rollback that goes back to a stale store, or a restore from a snapshot, re-applies the erasures recorded since | `ErasureLedger` in the copy executors; `replayErasures` in `in-place-evolve`; a kit case |
| **Tenant scope** | capture, apply, verify, fence, and retire are scoped by tenant on a pooled store | the SPI's `DatasetScope`; kit cases |
| **Evidence, not payload** | facts, digests, and conformance reports carry no record | the `verify` port; kit cases assert a sentinel payload never appears in evidence |
| **Single write authority** | a fenced writer is refused; authority flips once | the `fence` port; kit cases |

**Continuous means re-evaluated, not evaluated once.** A migration can sit in `converge` for days. The
executors recompute the verdict before **every** phase. A verdict that turns negative holds the
migration at its last safe state and records why in a `migration.Held` fact; nothing in the phase runs;
the source stays writable; and when the verdict passes again the run resumes from where it stopped.
Because retention is evaluated against the instant, the *same* path fails later once a copy outlives
its deadline — which is the point.

`can-trail` accepts the computed verdict. A relay in a denied region blocks the trail and the reason
names the custody point, where the boolean inputs would have passed it.

## 9. Verification

One suite, `runEngineConformance` in `@hobo/data-core`, run against any binding through a harness
that creates fresh stores. Passing `peer` makes the pattern cases cross-engine: the engine under test
is the source and the peer is the target.

| Case | Proves |
|---|---|
| `declaration.matches-binding` | the binding provides exactly the ports it declares |
| `datasets.ensure-idempotent` | provisioning is idempotent and describable |
| `records.round-trip-canonical` | every canonical type — a 64-bit integer beyond 2^53, a decimal, an offset timestamp, bytes, a uuid, nested json, an opaque encrypted value — reads back byte-identical |
| `records.tenants-are-isolated` | the same key in two tenants is two records |
| `mapping.constrained-never-silent` | a value at the edge of what the engine can hold — an extreme integer, a 49-digit decimal, microsecond time, U+0000 in text, JSON keys an engine reserves — round-trips exactly or is refused; it is never stored altered |
| `apply.idempotent-with-watermark` | re-applying a batch changes nothing; the watermark is recorded; an empty batch still advances it |
| `verify.digest-is-engine-independent` | the engine's digest equals the canonical digest of the same records, and carries no payload |
| `snapshot.returns-the-scope` | a scan returns every record in scope once, in chunks, within its tenant |
| `capture.ordered-and-resumable` | changes arrive in commit order, strictly after the start, non-consuming, with an idempotent start |
| `capture.tenant-scope` | a scoped subscription sees only its tenant |
| `fence.single-write-authority` | a fenced write is refused with `FencedWriteError`; the token writes through; another tenant is untouched |
| `fence.raise-waits-for-in-flight-writes` | writes racing the fence either land before `raise` returns or are refused; none lands afterwards |
| `retire.refused-unless-proven` | retire is refused without the fence, and with a stale digest |
| `pattern.snapshot-and-tail.zero-loss-under-load` | with writes arriving between every phase, both sides digest equal at the fence, authority moves once, and the old authority then refuses writes |
| `pattern.snapshot-and-tail.resumes-at-every-boundary` | a crash injected after each of eight phases resumes to completion with no record lost or duplicated |
| `pattern.snapshot-and-tail.lossless-soak-rollback` | a write made after the flip survives a rollback under a reverse tail |
| `pattern.snapshot-and-tail.rollback-never-resurrects` | without a reverse tail the posture is reported `to-snapshot`, the loss is stated, and an erased subject stays erased |
| `pattern.snapshot-and-tail.tenant-move` | one tenant leaves a pooled store; the other is untouched |
| `pattern.offline-copy.exact` | a fenced copy arrives complete and the source is retired |
| `pattern.in-place-evolve.gated-and-restorable` | a consumer on the old shape blocks the destructive phase and keeps the dual window open |
| `pattern.in-place-evolve.failure-restores` | a failed phase restores the snapshot and re-applies erasures; the same plan then completes |

The fold is pessimistic. A failure is `fail`; a case that applies but could not run is `not-run`,
which makes the outcome `unknown`; and `unknown` is as non-selectable as `fail`. A case whose port the
engine does not declare is skipped — not forgiven: the pattern needing that port is ineligible at
selection.

What runs where:

| Lane | Runs in the default test lane | What it exercises |
|---|---|---|
| Reference engine, same- and cross-engine | yes | the kit itself, and every executor |
| SQLite ↔ SQLite, SQLite ↔ reference (both directions) | yes | the whole kit against real files, including `in-place-evolve` over real DDL |
| Event-log patterns on the real SQLite event store + SQLite engines | yes (`@hobo/trails`) | `rebuild-and-swap`, `log-pivot`, `stream-handoff` on disk; the migration journal on the event store |
| MongoDB over its in-memory executor | yes | the binding's logic without a server |
| PostgreSQL, live | opt-in: `HOBO_TEST_POSTGRES_URL` | the whole kit against a real server, including logical-decoding capture |
| MongoDB, live | opt-in: `HOBO_TEST_MONGODB_URL` | the whole kit against a real replica set, including change streams |
| Cross-engine among SQLite, PostgreSQL, and MongoDB, live | opt-in: both variables | real records moving between real engines of different paradigms |

What the last full run recorded (2026-11-10; PostgreSQL 16.15 with `wal_level=logical`, MongoDB 8.0.4
single-node replica set, Node 22):

| Run | Outcome | Cases passed | Skipped |
|---|---|---|---|
| SQLite ↔ SQLite; SQLite ↔ reference, both directions | `pass` | 21 of 21 as engine | none |
| PostgreSQL ↔ PostgreSQL; PostgreSQL → reference | `pass` | 21 of 21 | none |
| MongoDB ↔ MongoDB; MongoDB → reference | `pass` | 19 of 19 | the two `schema` cases — MongoDB declares no `schema` port |
| SQLite → PostgreSQL, PostgreSQL → SQLite | `pass` | 21 of 21 | none |
| SQLite → MongoDB, MongoDB → SQLite | `pass` | 21 / 19 | none / the two `schema` cases |
| PostgreSQL → MongoDB, MongoDB → PostgreSQL | `pass` | 21 / 19 | none / the two `schema` cases |

The kit earned its keep while it was being built. It caught the SQLite binding declaring strings
`exact` while storing text truncated at the first U+0000 — now refused and declared `constrained` — and
the engine work in turn caught the canonical model moving first-century dates to the twentieth
(`Date.UTC`'s two-digit-year rule) and digesting a lone surrogate ambiguously; both are fixed in
`@hobo/data-core`, with tests.

Beyond the kit: the selector, custody verdict, canonical model, and aggregate have their own tests;
the CUE constraints are vetted against real parser output; and each package's Pact contracts are
replayed against its code rather than merely kept on file.

## 10. Honest limits

- **Cross-paradigm movement of an authoritative store still needs an authored model.** `log-pivot`
  makes it reviewable and replayable; it does not make it automatic. And it compares digests only when
  the sink keeps the source's schema — a genuine re-model changes the records, and the evidence is then
  positional.
- **There is no transaction across source and target.** Convergence is bounded lag plus a fence. The
  flip is brief, not zero-duration.
- **The hub carries canonical records and nothing else.** Sequences, triggers, stored procedures,
  secondary indexes, foreign keys, and server-side functions do not cross it. A dataset provisioned
  through the hub has a primary key and typed columns.
- **A `native` realization is selected, not yet executed, by this layer.** The selector can choose
  `migration.postgres.logical-copy/v1`; running it is the engine package's plan builder plus an
  executor the caller supplies. The executors here run the `hub` realization.
- **`stream-handoff` re-mints event identity.** The event-store port has no identity-preserving
  import, so a handed-off event keeps its stream, sequence, type, version, payload, actor, and tenant,
  and is given a new id and timestamp; the originals travel in `meta.handoff`. Every handoff reports
  `HANDOFF_EVENT_IDENTITY_REMINTED`.
- **Two of three fences are entry-point fences.** SQLite and MongoDB stop writers that go through the
  binding. A process with its own connection is not stopped. PostgreSQL's is enforced by the store —
  by a trigger, which a table owner or superuser can still disable.
- **MongoDB needs a replica set.** Not only for change streams: atomic `write`, `apply`, and `retire`
  are multi-document transactions, which a standalone server does not have. The binding refuses
  rather than degrade.
- **The PostgreSQL schema snapshot is a table copy in the same database.** It refuses tables with
  foreign keys, triggers, identity columns, row security, partitions, or inheritance rather than
  restore them unfaithfully.
- **Writes are one statement per record.** There is no batching yet in the PostgreSQL binding, and one
  MongoDB transaction bounds one atomic unit, so a very large batch is refused rather than split.
- **Ill-formed text is refused by the model.** A lone surrogate has no UTF-8 encoding; every engine
  would store U+FFFD in its place, so the canonical parser refuses it for all of them.
- **The live PostgreSQL and MongoDB lanes are opt-in.** They need a server, and the default CI lane
  does not provide one, so a regression in live capture is caught by whoever runs the lane, not by
  every push. The always-on lanes cover the contract logic, the decoder against recorded bytes, and
  SQLite for real.
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
