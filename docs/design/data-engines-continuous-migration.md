---
type: Reference
title: "Data Engine Packages & Continuous Data Migration"
description: "Target package family for data engines (a common engine-neutral contract plus one package per engine) and the continuous-migration pattern catalog, deterministic pattern selection, and continuous policy gate that let data move between products, engines, and paradigms."
tags: [hobo, design, data-plane, migration, architecture]
---

# Data Engine Packages & Continuous Data Migration

Decision record: [ADR-0177](./adr/03-data-plane.md#adr-0177). This note is the design behind it: *what
the units are*, *what an engine must implement*, *which migration patterns exist and when each is
legal*, and *how policy holds for every intermediate state*. It extends
[data-plane.md §Migrations](./data-plane.md#migrations--cross-cloud-portability)
([ADR-0032](./adr/03-data-plane.md#adr-0032)) and the Trails engine
([ADR-0134](./adr/02-identity-security.md#adr-0134)); it replaces neither.

**Most of the concepts already exist.** Expand/backfill/contract, snapshots, CDC duals, migration
profiles, the residency evaluator, and the Trail runner are all implemented. What is missing is the
seam between them: there is no contract an engine implements, no named catalog of migration
patterns, and no computed policy verdict. Where something genuinely does not exist yet, this note
says so.

## 1. What is wrong today

| Finding | Evidence | Why it blocks "move data between engines" |
|---|---|---|
| Engine code lives inside the orchestrator | `packages/trails/src/schema-apply-port.ts` and `data-dual-port.ts` import `node:sqlite` directly; SQLite is the only live `SchemaApplyPort`/`DataDualPort` binding ([upgrade-migration-engine](./upgrade-migration-engine.md) M2 carried risk 5, M4 carried risk 4) | A second engine would have to be added *to `@hobo/trails`*. The runbook engine becomes the place every engine's driver accumulates. |
| No shared engine contract | `@hobo/data-postgres` owns a profile, a conformance suite, and two migration profiles (argv builders) — but implements none of the ports Trails executes. `@hobo/kv-redis-compatible` re-implements the same pessimistic conformance fold | "Supports Postgres" has no single meaning: authoring, conformance, and migration execution are three unconnected surfaces. |
| The pattern is an untyped mode string | `TrailStep.data.mode: "bulk" \| "delta" \| "cdc-dual"`; `schema.mode: "versioned-sql" \| "declarative-desired" \| "expand-contract"` | Nothing states which pattern is *legal* for a given source, target, and downtime budget, and nothing records *why* one was chosen. Cross-engine is one sentence in ADR-0032 §5. |
| Policy inputs are asserted, not computed | `CanTrailInput.residencyConflict?: boolean`, `policyAllows?: boolean` | The gate cannot see the dump file, the runner that relays rows, or the rollback snapshot — the places a compliant-at-both-ends move actually leaks. |
| Verification moves rows into the control plane | `DataDualView.sourceRows` / `targetRows` are read into the runner and hashed there | Fine for a fixture; in production the oracle itself becomes a custody point for the data it is checking. |
| The schema IR is single-dialect | `SchemaIr.dialect: "postgres"` in `@hobo/core` `ports/schema-diff.ts` | The IR is the right owner ([ADR-0160](./adr/03-data-plane.md#adr-0160)); the dialect *emitters* have no home outside the Postgres path. |
| Engine and product share one closed enum | `DataStoreProvider` in `@hobo/core` (`sqlite-local`, `cloudflare-d1`, `supabase-postgres`, `aws-rds`, …) | An engine fact (speaks Postgres logical replication) and a product fact (this plan disables it) are different declarations with different owners. |

## 2. Three grains, three audiences

"Postgres", "SQL", and "MongoDB" are not the same kind of thing, and the package family should not
pretend they are. The capability refinement graph
([ADR-0151](./adr/07-portability-extensibility.md#adr-0151), `@hobo/manifest-capability`) already
separates the grains; packages follow it.

| Grain | Example | Profile node | Package family | Audience |
|---|---|---|---|---|
| **Paradigm** | relational, document, key-value, graph, vector | `data.relational/v1`, `data.document/v1` | `@hobo/data` (portable default) and the opt-in idiom layers `@hobo/sql` / `@hobo/document` / `@hobo/vector` / `@hobo/graph` ([ADR-0081](./adr/03-data-plane.md#adr-0081)) | app authors |
| **Engine** | PostgreSQL, MySQL, SQL Server, SQLite, MongoDB | `data.postgres/v1`, `data.mysql/v1`, `data.sqlite/v1` | **`@hobo/data-<engine>`**, derived from **`@hobo/data-core`** | engine/platform authors |
| **Product** | Neon, RDS, Cloud SQL, Atlas, D1 | declares which engine profile it implements, with evidence | `@hobo/provider-<product>` | provider authors |

**The engine is the right grain for migration mechanics.** A wire protocol, a type system, DDL
semantics (is DDL transactional?), a replication mechanism, and a dump format are properties of the
engine. Every product of that engine shares them; no two engines do. A product only narrows the set
(a serverless endpoint that speaks Postgres but cannot run `pg_dump`), and that narrowing is already
a declaration-side fact (`logicalReplication`, `exportSupported`, `migrationToolCompatibility` in
`@hobo/data-postgres`).

"SQL" is therefore not a package. It is the relational *paradigm*; its engines are separate packages
because their dialects, types, and replication are not substitutable
([ADR-0081](./adr/03-data-plane.md#adr-0081) §2 already says SQL Server and MySQL are separate engine
classes).

## 3. Package topology

```
@hobo/core                 ports that adapters implement (unchanged): SchemaIr + diff, jurisdiction, EventStore
@hobo/data                 app-facing CQRS kernel: command / projection / repo / view (unchanged)

@hobo/data-core     NEW    the engine-neutral contract every engine package derives from
  ├─ engine SPI            the ports in §4
  ├─ change envelope       canonical capture/apply record + type-mapping annex vocabulary
  ├─ pattern catalog       the six continuous-migration patterns in §5
  ├─ pattern selector      pure, deterministic: hard gates then lexicographic order (§7)
  ├─ policy verdict        custody path → computed residency/classification/erasure verdict (§8)
  └─ conformance kit       the shared pessimistic fold + the engine-contract suite (§9)

@hobo/data-postgres        exists — gains the SPI implementation; keeps authoring, vocabulary, profiles
@hobo/data-sqlite   NEW    the SQLite bindings extracted from @hobo/trails, behind the SPI
@hobo/data-mongodb  NEW    document engine: profile data.mongodb/v1 (new node refining data.document/v1)
@hobo/data-mysql, @hobo/data-sqlserver      added on demand; same shape

@hobo/trails               orchestrator only: runs patterns over data-core ports, imports no engine
@hobo/provider-*           products: declare an engine profile + evidence; contain no engine logic
```

**Why the common package is `@hobo/data-core` and not `@hobo/data` itself.** `@hobo/data` is the
app-authoring namespace in the import-ownership map ([package-namespaces](./package-namespaces.md),
ADR-0087), and it depends on `@hobo/storage-sqlite` for the durable actor host. Putting the engine
contract there would (a) give app authors and engine authors one import site, which is what that map
exists to prevent, (b) make every engine package depend transitively on one particular engine, and
(c) put three compatibility regimes on one version line — an app API that must stay stable, an engine
SPI that widens only with conformance, and a pattern catalog that is append-mostly and gated like the
capability catalog ([package-decomposition](./package-decomposition.md) §1: one package cannot enforce
different rules over one schema). `@hobo/data-core` holds protobuf + CUE records, pure functions, and
port types; it imports `@hobo/core` and nothing else, and classifies as a layer-1 `contract` package
in the boundary gate, which is what lets adapters import it.

**What moves.** `SchemaApplyPort`, `DataDualPort`, and the tenant-move protocol's store operations
move from `@hobo/trails` to `@hobo/data-core` as *types*; their `node:sqlite` implementations move to
`@hobo/data-sqlite`. The boundary gate then forbids `@hobo/trails` from importing any
`@hobo/data-<engine>` package — the inversion in §1 becomes unrepresentable rather than discouraged.
Dialect SQL emitters move beside their engine; the IR and the differ stay in `@hobo/core`.

**What does not move.** The Trail definition, runner, history, `can-trail`, and progressive ramp stay
in `@hobo/trails`. The claim-migration coordinator stays in `@hobo/claims`. Capability profiles stay
in `@hobo/manifest-capability` / `@hobo/capability-profiles`. This is separation and naming, not a
second migration system.

## 4. The engine contract

An engine package is **complete** when it ships all of: the engine profile's authoring helper and
advertised vocabulary; a conformance suite for that vocabulary; the SPI ports below (each optional
port either implemented or explicitly declared absent); its migration profiles, each naming the
pattern it realizes; a type-mapping annex; and a closed list of impedance codes
([ADR-0144](./adr/07-portability-extensibility.md#adr-0144)). Absence is a declaration, never a
missing export: a port an engine cannot provide is what makes a pattern ineligible in §7.

| Port | Contract | Honest limit it surfaces |
|---|---|---|
| `SchemaApplyPort` | apply one expand / backfill / contract phase atomically; snapshot; restore; run a violations query (exists today in `@hobo/trails`) | whether DDL is transactional — MySQL's implicit commit is a declared fact, not a surprise |
| `SnapshotPort` | export a consistent image at a named cut position to an artifact ref with a digest; import it | whether the cut is consistent without a write freeze |
| `ChangeCapturePort` | emit ordered `ChangeEnvelope`s strictly after a position; the position is durable and resumable | ordering scope (global, per-table, per-key) and whether deletes carry the prior image |
| `ChangeApplyPort` | apply envelopes idempotently, keyed by source position; expose the applied watermark | exactly-once *effect* over at-least-once delivery, or not |
| `VerifyPort` | return counts and ranged digests computed **store-side** for a key range at a position | digests only — a row never crosses this port |
| `WriteFencePort` | raise a fence with a token; a fenced writer is refused; release only by the token holder | whether the fence is enforced at the store or only at HoBo's write entry point |
| `RetirePort` | destructive removal of a source; refused without a verified digest match and a raised fence | — |

**The change envelope is the hub.** `ChangeEnvelope` carries `{ position, key, op, record, schemaVersion,
tenant, classification }`, where `record` is the canonical WIT-record value
([ADR-0051](./adr/03-data-plane.md#adr-0051)) in its protobuf encoding. Every engine implements
capture *into* it and apply *out of* it. That makes cross-engine movement **hub-and-spoke**: N engines
cost N adapters, not N² pairwise migrators, and a new engine can be a source or target for every
existing one on the day it passes conformance. Same-engine moves keep their **native fast path**
(Postgres logical replication, an engine's own online-copy tool) as a migration profile; the hub is the portable floor, not
a tax on the common case.

The envelope stream is a transport channel, **not** event-log facts: payload in the log would make
the log a custody point for data in flight. Only checkpoints — positions, watermarks, digests — are
recorded as facts. The exception is deliberate and named: `log-pivot` (§5) appends changes as domain
events because moving authority into the log is that pattern's purpose.

**The type-mapping annex.** Each engine declares canonical ↔ native type mappings, each edge classed
`exact`, `widening`, or `lossy` with a reason (numeric precision, collation, timezone handling,
document nesting depth, key length). A cross-engine plan composes source→canonical→target; any `lossy`
edge is an impedance finding that fails the gate unless explicitly waived
(`policy.WaiverRequested`, [event-families](./event-families.md)). This is how "seamless" stays honest: a move is
seamless when the composed mapping is exact, and *says so in the plan* when it is not.

## 5. The pattern catalog

Two questions pick the pattern family. **What changes** — *shape* (same store), *placement* (same
engine, different product, region, or tenancy), *engine* (same paradigm), or *paradigm*. And **who is
the authority** — the event log (*projected* data: the store is a derived sink), the store itself
(*authoritative*: an app-owned relational resource or an adopted store,
[ADR-0041](./adr/07-portability-extensibility.md#adr-0041)), or the *journal* (the EventStore's own
persistence, [ADR-0135](./adr/03-data-plane-sqlite-default.md)).

Authority is the pivot, and it is where HoBo's design pays off: **for projected data the store was
never the truth, so every move — including across paradigms — is a replay.** No capture, no dual run,
no lossy translation of stored bytes. The hard patterns exist only for authoritative stores.

| | Shape | Placement | Engine | Paradigm |
|---|---|---|---|---|
| **Projected** | `rebuild-and-swap` (or `in-place-evolve` for large relational sinks) | `rebuild-and-swap` | `rebuild-and-swap` | `rebuild-and-swap` with a new architect-authored mapping |
| **Authoritative** | `in-place-evolve` | `snapshot-and-tail` · `offline-copy` | `snapshot-and-tail` over the hub | `log-pivot` |
| **Journal** | upcasters ([Plan 11](./data-plane.md#plan-11)) — not a migration | `stream-handoff` | `stream-handoff` | — |

| Pattern | What it does | Rollback posture | Needs from the engine | Realized today by |
|---|---|---|---|---|
| `in-place-evolve` | expand → backfill → contract in the live store; old and new app versions both run through the dual window | lossless until contract; snapshot-restore after | `SchemaApplyPort` | `@hobo/trails` migration executor + `@hobo/adapter-drizzle` |
| `rebuild-and-swap` | provision the new sink, replay the log into the new mapping, converge to live `seq`, verify, flip the read binding, reap | lossless always — the old sink stays valid until reaped | `ChangeApplyPort` on the target only | design in [data-plane §Projection sinks](./data-plane.md#projection-sinks-rebuild-from-zero-vs-in-place-migration); no executor |
| `offline-copy` | fence writes → export → import → verify → flip → release | lossless (source untouched until retired) | `SnapshotPort`, `WriteFencePort` | `migration.postgres.pg-dump/v1` |
| `snapshot-and-tail` | seed from a snapshot at position P, tail changes after P until lag is within bound, verify, shift reads progressively, fence and flip write authority once, tail **in reverse** through the soak window | lossless while the reverse tail runs; snapshot-restore after | `SnapshotPort`, `ChangeCapturePort` (source), `ChangeApplyPort` (target); both directions for a lossless soak | `migration.postgres.logical-copy/v1`; the SQLite pooled→silo protocol |
| `log-pivot` | adopt the store, capture its changes into the log as domain events, then treat the target as a projection | lossless until the write flip; **authority moves to the log permanently** | `ChangeCapturePort`, an authored fold | design only ([ADR-0041](./adr/07-portability-extensibility.md#adr-0041) strangler) |
| `stream-handoff` | copy streams to the new store by position, fence `owner_epoch`, drain the tail, flip the single writer | lossless — append-only with per-stream `seq` | the `EventStore` port itself | design only ([yard-first-placement](./adr/yard-first-placement.md)) |

`log-pivot` is a one-way door and is labelled as one. It is also the only honest answer to
cross-paradigm movement of an authoritative store: relational → document is a *re-model*
([data-plane non-goal](./data-plane.md#projection-scope)), and the fold is where the re-modelling is
written down, reviewed, and replayable. What HoBo automates is the movement, verification, and
cutover — never the modelling.

**Application-level dual-write is not in the catalog, by decision.** Two independent writes with no
shared transaction diverge on the first partial failure, and the divergence is silent. Every pattern
above keeps **exactly one write authority at any log position**; the second store is fed by capture,
and authority changes hands only under a fence token. This is the same single-writer rule the
EventStore already enforces ([ADR-0135](./adr/03-data-plane-sqlite-default.md)), applied to migration.
The existing `migrate.dual-write` offering id and `cdc-dual` step mode name this *dual-run* behaviour;
the vocabulary is aligned in the delivery slices (§11) without a wire break.

## 6. One phase model, one aggregate

Every pattern is a subset of one ordered phase list, so one migration aggregate, one event family,
and one set of gates cover all six:

```
plan → gate → prepare → seed → converge → verify → shift-reads → fence+flip → soak → finalize
```

| Phase | Meaning | Safe hold? |
|---|---|---|
| `prepare` | provision target, expand schema, create capture slot | yes — nothing has moved |
| `seed` | snapshot import / backfill / replay from zero; chunked, idempotent, resumable | yes — source is sole authority |
| `converge` | tail until lag ≤ the declared bound | yes — indefinitely; costs a second copy |
| `verify` | counts + ranged digests at a common position | yes |
| `shift-reads` | progressive read ramp through the Harness flag store ([ADR-0083](./adr/02-identity-security.md#adr-0083)); reads are idempotent, so this is reversible at any percentage | yes |
| `fence+flip` | the only non-holdable step: raise the fence, drain to lag 0, move write authority, rotate the binding | **no** — bounded, atomic, or compensated |
| `soak` | the rollback window; reverse tail keeps the old side current where the pattern supports it | yes — until its deadline |
| `finalize` | contract / retire the source / revoke migration identities / reap artifacts | terminal, destructive, gated |

A **safe hold** is a state the migration can sit in indefinitely without losing data or violating
policy. Naming it per phase is what makes a long-running migration pausable by a policy change, a
budget breaker, or an operator without anyone improvising.

**Rollback posture is a declared class, not a promise:** `lossless` (the other side is current),
`to-snapshot` (writes since the snapshot are lost and the plan says how many seconds that is), or
`none` (after finalize). A pattern/engine pair that cannot provide a reverse tail reports `to-snapshot`
for its soak window, and the selector ranks it below one that can.

**Events.** No new family. The aggregate reuses `migration.*`
([event-families](./event-families.md)): `migration.Planned` gains the selected pattern, the rejected
alternatives with reasons, the custody path, and the catalog digest; `migration.PhaseApplied` gains
the phase names above. Both are body changes governed by the existing upcaster-totality gate and
golden-replay corpus ([upgrade-migration-engine](./upgrade-migration-engine.md) M4) — additive fields
where possible, a version bump with a total upcaster where not. Policy decisions ride
`policy.Decided`, obligations `policy.ObligationCreated` / `policy.ObligationSatisfied`, erasure
`erasure.Requested` / `erasure.Completed`, and binding rotation at cutover stays the claim
coordinator's `CapabilityBindingRotated` fact (`@hobo/claims`).

## 7. Pattern selection is deterministic and recorded

Choosing a pattern is a Matching-class decision ([ADR-0033](./adr/01-architecture-core.md#adr-0033)):
a pure function, no clock, no model on the path, same inputs → same digest.

**Inputs:** the source and target engine declarations (profile, SPI ports present, migration
profiles, type-mapping annex); the authority mode; what changes; the declared constraints (maximum
write-freeze, maximum lag, required rollback posture); and the policy context (§8).

**Hard gates, fail-closed:** the pattern is legal for this authority × change cell; both engines
provide the ports it needs; the composed type mapping has no un-waived `lossy` edge; conformance
evidence for every needed port is fresh; the policy verdict passes; the freeze the pattern needs fits
the budget.

**Then lexicographic order — never a weighted score** ([ADR-0151](./adr/07-portability-extensibility.md#adr-0151)
§11): stronger rollback posture → no write freeze → native realization over the hub → fewer custody
points → lower estimated cost → stable pattern id.

**No silent downgrade.** If only a pattern needing a write freeze survives and the budget is zero, the
result is a rejection with every candidate's reason — the same agent-correctable shape as
`deployment.PlanRejected` — not a quiet fall back to downtime.

## 8. Policy holds for every intermediate state

A move that is compliant at both ends can still be non-compliant in the middle. The plan therefore
carries a **custody path**: every place the data rests or passes, each with a region and a retention
deadline — source, target, staging artifacts, the runner that relays rows, capture slots and logs, the
rollback snapshot, and the old source through soak. The verdict is *computed* from that path; nothing
asserts a boolean.

| Invariant | Rule | Mechanism |
|---|---|---|
| **Residency at every custody point** | each point's region passes `evaluateResidency` for the dataset's constraint; an unmapped region is a conflict | `@hobo/core` jurisdiction port ([ADR-0146](./adr/02-identity-security.md#adr-0146)); a relay in the wrong region fails the plan even when source and target are both allowed |
| **No classification downgrade** | the target and every artifact store meet the protections the classification requires (encryption at rest, field-level keys, access scope, audit) | hard gate on the target declaration; a plaintext analytics sink is not a legal target for encrypted fields |
| **Erasure continuity** | ciphertext moves as ciphertext — fields under a forgetting key are never decrypted in flight, so destroying the key erases every copy, artifact, and snapshot at once ([ADR-0032](./adr/03-data-plane.md#adr-0032) §7) | envelope carries encrypted fields opaquely |
| **No resurrection** | for stores holding plaintext, every restore, import, or backfill ends by re-applying erasures recorded since the artifact's cut position; a rollback may never bring back an erased subject | `erasure.*` replay after restore; a conformance case in §9 |
| **Bounded copies** | every artifact and the retiring source is a recorded fact with a deadline and a reap obligation; an orphan copy is a failed obligation, not a tidy-up task | `policy.ObligationCreated` / `policy.ObligationSatisfied` |
| **Tenant scope** | capture, apply, and verify are tenant-scoped on pooled stores; one tenant's divergence never masks or fails another's ([ADR-0080](./adr/02-identity-security.md#adr-0080)) | already true of the SQLite silo protocol; becomes an SPI requirement |
| **Evidence, not payload** | plans, events, receipts, and oracles carry positions, counts, and digests — never rows, never credentials | `VerifyPort` returns digests; credentials are `secretRef` locators ([ADR-0027](./adr/02-identity-security.md#adr-0027)) and never reach argv |
| **Least authority, then none** | source identity is read + replicate; target identity is write; both are revoked at finalize | binding rotation at cutover; revocation is a finalize obligation |

**Continuous means re-evaluated, not evaluated once.** A migration can sit in `converge` for days. The
verdict is recomputed before every phase transition and on any policy-relevant fact: a policy pack
change, `data.Classified`, `resourcedef.Updated`, conformance evidence expiring, a spend breaker
tripping, `erasure.Requested`. A verdict that turns negative moves the aggregate to its current
phase's safe hold, or compensates if no hold remains legal. A terminal `policy.Decided` denial is never
retried ([ADR-0136](./adr/03-data-plane-effects-resiliency.md)).

The verdict feeds the existing gate. `can-trail` keeps its shape; its residency and policy inputs stop
being caller-supplied booleans and become evidence derived from the custody path.

## 9. Verification

Each row is a case in the `@hobo/data-core` conformance kit, run against an engine package through
injected executors. An engine that cannot run a case reports `not-run`, which makes the outcome
`unknown`, which is non-selectable — the fold `@hobo/data-postgres` already uses, lifted to the
common package so every engine inherits it.

- **Zero loss under load:** writes continue through seed and converge; at the fence position, counts
  and ranged digests are equal.
- **Single authority:** after the flip, a write presenting the old fence token is refused; no position
  is accepted by both sides.
- **Idempotent apply:** replaying capture from an earlier position produces an identical digest.
- **Resume everywhere:** a crash injected at every phase boundary resumes to the same final digest.
- **Lossless soak:** a rollback during soak under a reverse tail loses no acknowledged write; without
  one, the report states the loss window instead of claiming none.
- **No resurrection:** erase a subject, restore a pre-erasure snapshot, assert the subject is absent.
- **Custody honesty:** a plan whose staging artifact or relay sits in an unmapped or denied region is
  refused, with source and target both allowed.
- **Evidence only:** no verification record, event body, or receipt contains a row payload.
- **Selector determinism:** identical inputs produce an identical decision digest; a rejected plan
  names a reason for every candidate.
- **Mapping honesty:** a composed mapping with a `lossy` edge fails the gate without a waiver.

## 10. Honest limits

- **Cross-paradigm movement of an authoritative store still needs an authored model.** `log-pivot`
  makes it reviewable and replayable; it does not make it automatic.
- **There is no transaction across source and target.** Convergence is bounded lag plus a fence. The
  flip is brief, not zero-duration; a pattern states its freeze in the plan.
- **The hub is slower and thinner than a native path.** It carries canonical records, not
  engine-specific objects — sequences, triggers, stored procedures, engine-specific index types, and
  server-side functions do not cross it and are reported as impedance.
- **Live change capture per engine is real work.** Postgres logical replication, MySQL binlog, SQL
  Server CDC, and Mongo change streams are four different mechanisms with different ordering and
  retention behaviour. Only the SQLite journal capture exists today.
- **Vector and graph sinks have no within-class guarantee** ([ADR-0081](./adr/03-data-plane.md#adr-0081)
  §2). They move by `rebuild-and-swap`; re-embedding is non-deterministic, so verification is by id
  set and count, not by vector equality.
- **Multi-region active-active is out of scope** — an
  [ADR-0040](./adr/01-architecture-core.md#adr-0040) topology concern, not a migration pattern.

## 11. Delivery slices

Each slice is independently shippable and gate-green; none requires the next.

1. **`@hobo/data-core` contract.** Protobuf + CUE for the pattern catalog, phase model, custody path,
   change envelope, type-mapping edge, and decision record; the selector and the policy verdict as
   pure functions; the lifted conformance fold; a PACT for the selector boundary and a golden corpus
   for decisions. No engine code, no I/O.
2. **`@hobo/data-sqlite` extraction.** Move the `node:sqlite` bindings out of `@hobo/trails` behind the
   SPI; `@hobo/trails` imports ports only; the boundary gate forbids the reverse edge.
   Characterization tests pin zero behaviour change.
3. **`@hobo/data-postgres` implements the SPI** behind injected executors, maps its two migration
   profiles to `offline-copy` and `snapshot-and-tail`, and adopts the shared fold. The live lane stays
   credential-gated per [live-provider-matrix](./live-provider-matrix.md).
4. **First cross-engine evidence.** SQLite → Postgres `snapshot-and-tail` over the hub, and a projected
   sink SQLite → Postgres by `rebuild-and-swap` — the two halves of the portability claim, each with
   the §9 cases.
5. **`@hobo/data-mongodb`** with a `data.mongodb/v1` profile node, document `rebuild-and-swap`, and
   `log-pivot` for one adopted relational store.
6. **`@hobo/data-mysql` / `@hobo/data-sqlserver`** on demand. The engine contract is small and
   conformance-checked on purpose: these are candidates for generated adapters certified through the
   existing pipeline ([ADR-0010](./adr/03-data-plane.md#adr-0010)).

Alongside slice 2, `SchemaIr.dialect` widens from the literal `"postgres"` and per-engine emitters
move beside their engines; `DataStoreProvider` in `@hobo/core` is split into an engine fact and a
product fact.

## 12. Decisions left to the owner

- **The common package's name.** This note uses `@hobo/data-core`. The alternative is a
  `@hobo/data/engine` subpath; §3 gives the reasons against, and the only cost of changing the answer
  before slice 1 is a rename.
- **Whether `log-pivot` is in the first release.** It is the only cross-paradigm answer for
  authoritative stores and the only pattern that permanently changes authority. Deferring it leaves
  the catalog at five patterns with cross-paradigm limited to projected data.
- **Which engines after Postgres and SQLite.** The profile graph has `data.mysql/v1` and no SQL Server
  or MongoDB node; slice 5 assumes MongoDB is next.
