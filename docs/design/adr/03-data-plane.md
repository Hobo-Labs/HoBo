---
type: Architecture Decision Record
title: "Data plane, AI generation, agents & operators — consolidated decisions"
description: "**Event-sourced domain data, reactive over the log, streamed by default; backends are projection sinks.**"
tags: [hobo, design]
---

# Data plane, AI generation, agents & operators — consolidated decisions

> Consolidated ADR decisions for **the data plane, AI generation, agents & operators**. Each section is one architecture decision; see [`README.md`](./index.md) for the full ADR index.

## ADR-0050
**Event-sourced domain data, reactive over the log, streamed by default; backends are projection sinks.**

### Context
The append-only event log is the single source of truth, with projections rebuilt by folding it ([Plan 11](../data-plane.md#plan-11)). This extends to application **domain data**, not just HoBo's control-plane state: the system of record, a reactive read DX (`useQuery()`-style results that auto-recompute and push on write, with consistent snapshots) in a **multi-cloud** model where app data may live in varying *provider* databases, and the default read surface for an event-sourced + actor runtime where data is **materialized from streams** rather than stored-then-queried and a registration for event types already *is* a subscription. The data layer stays log-first, portable, and CAP-honest without coupling to provider `sql`/`kv`/`bucket` dialects.

### Decision
1. **Domain data is event-sourced by default.** Domain writes are **commands → events** appended to the log ([Plan 11](../data-plane.md#plan-11)); the log is the source of truth for domain data, exactly as for control-plane state. An **adopt-in-place escape hatch** lets an existing/external DB be declared **authoritative-external** via [ADR-0041](07-portability-extensibility.md#adr-0041) (`hobo import`, `external` kind, `echo` driver): the DB is the source of truth, writes go to it directly, and its `change-feed` (if any) feeds `data.Changed` so reactive reads still work. `hobo doctor` flags long-lived authoritative-external stores as migration debt — strangler-fig adoption without forcing CQRS on day one.
2. **A reactor over the log is the reactivity mechanism.** Reactive reads run over the **event log / projections** (native, portable, zero extra infra, on any Camp runtime); provider databases join via a **`change-feed` capability** on the `database` port, normalized into `data.Changed` so the *same* reactor handles DB-backed reads (Postgres reference adapter; sources without a change feed are typed `reactive: false`). Each pushed result is a **per-query consistent snapshot**, delivered in non-regressing order, with **reads-your-writes** — a mutation returns its `seq` and the client's subscriptions advance past it before the write acks. Because `seq` is **per-stream** ([Plan 11](../data-plane.md#plan-11)), a multi-stream materialization's position is a **per-stream `seq`-map (a vector), not a scalar** — reads-your-writes means "advance to ≥ the mutated stream's `seq`," and the snapshot is consistent per-stream, not a single global serialization point (too costly across streams + providers). The before-ack guarantee holds for **native log-backed materializations**; a read served from a `change-feed` **sink** is **bounded-staleness** (the change-feed propagation lag), not strict read-your-writes — `hobo doctor` surfaces which reads are which. Read-sets are auto-tracked per execution.
3. **Streaming-first RX materializations are the default read surface.** The default read primitive is **`subscribe(materialization | eventTypes) → Observable<T>`**: it replays history up to the current `seq`, then pushes live updates (RX "current value + updates", a `scan`/`ReplaySubject` over the log); the client default is **`useSubscription()`**. A **materialization** is the same artifact as a **projection** ([Plan 32](../data-plane.md#plan-32)) — a deterministic fold over subscribed event types — surfaced as a subscribable observable composed with RX operators (`map`/`filter`/`scan`/`distinctUntilChanged`/`combineLatest`/…) rather than a table you `SELECT` from; **registration = subscription** (declaring a materialization over event types creates its read-set). `useQuery()` is **sugar** for `useSubscription()` over a materialization. A `snapshot(m)` is the one-shot current value, **cached by default** (repeated point reads hit the cache, not a re-fold), with freshness governed by the entity's tunable consistency level ([ADR-0052](#adr-0052)).
4. **Querying-the-DB is the escape hatch.** Non-stream reads are first-class but explicit, served from the cache/sink and reached for when a subscription is the wrong shape (ad-hoc/point/analytical). The default structured query surface is a **GraphQL facade over materializations + cached snapshots** — CQRS querying of materializations produced by GraphQL reducers; alongside it: `snapshot(m)`/`runQuery` (one-shot current value), `repo.get(id)` (point lookup), `view(...).search(...)` ([Plan 32](../data-plane.md#plan-32)), `.raw(driver => …)` (non-portable), and OLAP/batch reads. `hobo doctor` nudges toward subscriptions for live views.
5. **Every backend is a derived projection sink.** A projection materializes a read model into an architect-chosen backend (SQL/NoSQL/KV/graph/vector/object-lake/OLAP) via a **schema mapping**: the developer owns the logical read-model record + queries; the **data architect owns the mapping + the backend**, selected via **Matching** ([Plan 25](../platform-engineering.md#plan-25)) and recorded in `match.Decided`. The native log-backed materialization is the default; a sink is an **opt-in durable, queryable cache** added when you need point-lookups, secondary indexes, search, analytics, or large fan-in. Same-store vs separate-query-DB is a `match.Decided` outcome, not a global architectural fork. Projections are **rebuildable from zero** (replay) — the test that the log, not the sink, is authoritative. At scale this is **checkpointed, resumable, snapshot-seeded, and shard-parallel with a catch-up-to-live cutover** (not an unbounded single-fold that restarts on failure); a **non-deterministic** sink (embeddings, [ADR-0034](#adr-0034)) can't be deterministically replayed, so it rebuilds via a **recorded-output backfill** (re-embed as a `step` into an expand phase), carved out from deterministic replay.
6. **One engine.** The reactor, snapshot@`seq`, reads-your-writes, the inverted read-set index, coalescing/backpressure, and the `change-feed` capability ([Plan 32](../data-plane.md#plan-32)) implement subscriptions, materializations, and escape-hatch queries alike; determinism rules for folds/operators are the `query()`/`workflow` rules. Reuse, don't reinvent: gated expand→backfill→contract for sink schema ([Plan 32](../data-plane.md#plan-32), where rebuild-from-zero *is* a backfill); single-writer-Camp replication + bounded-staleness labels ([ADR-0040](01-architecture-core.md#adr-0040)).
7. **Poison events + domain-log lifecycle have explicit paths** (append-only + pure folds otherwise wedge forever). A **poison event** (a body a deterministic fold/aggregate can't process — bad upcast, decode error) is handled by a **quarantine fact** (`*.Quarantined` recording the offending `seq` + reason) that lets the fold **skip it deterministically** — never a silent rewrite of the append-only log; the quarantine is itself an auditable event and a `hobo doctor`/incident signal. **Domain streams have a retention/compaction policy distinct from the never-compact audit streams** ([Plan 11](../data-plane.md#plan-11)): a high-volume domain aggregate may be **snapshot-and-truncated** (snapshot ≥ retention floor, older events tiered to cold storage with an audit marker), so "domain data on the log" doesn't grow unbounded — compliance-retained `token.*`/`resource.*`/policy streams stay never-compacted.

### Consequences
- **(+)** The read model matches the event/actor foundation — materialize-from-streams, subscribe-by-default, real-time push without opt-in — while developers work a logical model and architects place data on any backend, with audit/replay/time-travel/rebuildable read models covering **domain** data and the adopt-in-place escape hatch keeping existing-DB adoption viable.
- **(−)** CQRS + eventual consistency are the normal case (a projection lags the log by its fold/replication latency; reads-your-writes holds within the owning Camp but not instantly across every external sink, CAP-honest per [ADR-0040](01-architecture-core.md#adr-0040)), and RX is a different mental model than a plain query API. Per-entity consistency is tunable — see [ADR-0052](#adr-0052).

## ADR-0051
**WIT is the canonical domain schema; author it in any serialization that compiles to WIT.**

### Context
Three schema systems converge into one domain/DTO layer: **Zod** validators for step/workflow/query I/O ([Plan 2](../sdk-api.md#plan-02)), **WIT** types for ports ([Plan 20](../wasm-runtime-wit.md#plan-20)), and the **declarative SQL schema** for migrations ([Plan 32](../data-plane.md#plan-32)). The data plane ([ADR-0050](#adr-0050)) needs one **domain/DTO schema** that simultaneously defines event payload shapes, projection read-model shapes, and backend mappings. WIT is the canonical contract and its codegen ([ADR-0037](01-architecture-core.md#adr-0037)) flows from WIT, while app developers reach for familiar serializations (Zod, Protobuf) and need constraints richer than a structural type system expresses.

### Decision
1. **WIT is the canonical domain schema, authored in any serialization that compiles to it.** Domain types/DTOs resolve to **WIT records** ([Plan 20](../wasm-runtime-wit.md#plan-20)), but may be authored as **WIT records, Zod schemas, or Protobuf messages** — each compiles to the same canonical WIT. One record family is the single upstream for event payloads, projection/read-model shapes, and backend mappings, regardless of authoring surface.
2. **Constrain types with CUE, independent of how they're expressed.** Validation/refinement constraints (ranges, formats, cross-field invariants) are declared in **CUE** and apply to the canonical type regardless of authoring serialization — one constraint language across WIT, Zod, and Protobuf inputs.
3. **Generate the rest from canonical WIT** (extending [ADR-0037](01-architecture-core.md#adr-0037)'s codegen): **TS types** via `jco guest-types`; **Protobuf** message descriptors as the **wire encoding for event bodies**; **Zod validators** as a runtime-validation view. All deterministic, checked into `_generated/`.
4. **Protobuf is a wire encoding, not the only authoring language.** Event bodies in the `EventEnvelope` ([Plan 11](../data-plane.md#plan-11)) are Protobuf-encoded canonical records; whichever serialization authored the type, the wire form is consistent.
5. **One canonical type, many views.** Each domain type yields the TS type, Protobuf encoding, Zod validator, projection shape, CUE constraints, and [Plan 29](../contracts-policy-flags.md#plan-29)'s "Declared" contract from a single upstream.

### Schema versioning
Data/materialization schemas are **contract-tested like service boundaries** using the **PACT contract-testing versioning strategy** — consumer/provider expectations are pinned and verified per version, so a schema change that would break a live consumer is caught before deploy. Migration mechanics follow modern cross-DB practice (see [ADR-0032](#adr-0032) for the expand→backfill→contract apply model): event bodies evolve via [Plan 11](../data-plane.md#plan-11) upcasters; projection-sink schemas evolve via [Plan 32](../data-plane.md#plan-32) expand→backfill→contract. A domain-record change wires to both and is gated by its PACT contract. **Upcaster totality is gated, not assumed.** "Old events remain replayable forever" only holds if the upcaster chain is **total over every historical version** — so a **golden-replay corpus** (one pinned, real-encoded event body per `(type, v)` ever shipped, append-only) is replayed through the current chain in CI: a body the chain can't lift to the current version **fails `can-deploy`** ([Plan 9](../generated-stack.md#plan-09)) rather than wedging a fold in production. Adding a version bump without extending the corpus is itself a gate failure, so the corpus can't silently fall behind the schema.

### Forgetting & data subject rights
**Forward-only / no-history-rewrite is the default but is configurable for GDPR / right-to-be-forgotten.** Where a record must be forgotten, HoBo **crypto-shreds** — destroys the per-subject "forgetting key" so the record's encrypted fields become permanently unrecoverable, anonymizing the record **without rewriting history**. The log stays append-only; forgotten fields decrypt to tombstones. **Determinism caveat (stated, not hidden):** crypto-shred is a *deliberate, scoped* break of byte-identical replay — after a key is destroyed, a fold over the affected stream yields the anonymized value, so replay and time-travel return **post-erasure** content for shredded fields (the log *structure* replays identically; the decrypted *content* does not). Consequently **write-side aggregate invariants ([ADR-0053](#adr-0053)) must not depend on shreddable PII fields** (a uniqueness check over an erasable email would silently weaken post-shred) — codegen/lint flags an invariant over a `forgettable` field; and a **pre-erasure snapshot is re-keyed/invalidated** so it can't resurrect shredded content. Right-to-erasure is thus a configurable obligation with an explicit, bounded determinism tradeoff, not a silent history rewrite.

### Consequences
- **(+)** One domain schema yields TS + Protobuf + Zod + CUE constraints + projection shape + Declared contract, all generated and consistent and polyglot-friendly (canonical WIT records are language-neutral), reusing the WIT/jco/codegen machinery; PACT contract-testing makes schema evolution safe and crypto-shredding satisfies erasure without abandoning append-only history.
- **(−)** Multiple authoring front-ends plus the Protobuf/Zod/CUE emitters are more codegen to keep deterministic, and crypto-shredding requires per-subject key management and field-level encryption discipline.

## ADR-0052
**Projection-sink paradigm taxonomy, tunable consistency & the reactivity boundary.**

### Context
A persistence-agnostic data plane ([ADR-0050](#adr-0050)) implies many backend paradigms behind one projection abstraction. Two risks: (a) implying every paradigm is equally well-supported when only some have adapters, and (b) implying every backend can serve **reactive** queries when many cannot (no change-feed; analytical/batch engines). Different entities also need different freshness/consistency guarantees — a strong single default misstates cost; a weak one misstates correctness.

### Decision
1. **Model the projection sink as a paradigm-tagged kind** behind the `hobo:projection` port: a Matching dimension `type: "projection-sink", paradigm: relational|document|kv|wide-column|graph|vector|object-lake|olap|native`. Adding a paradigm is a new adapter behind the **stable port**, not a model change. The core ships **native** (log/standing projection), **relational** (Postgres reference), and **document** (Mongo reference); other paradigms (KV/wide-column, graph, object/data-lake, OLAP/columnar) are adapters behind the same port, and **vector/graph search backends are search extension libraries** ([ADR-0034](#adr-0034)) rather than core paradigms. The app-level dependency is a single generic **`data`** dep (not `sql`): the developer declares `data` and the **paradigm — relational/SQL, document/NoSQL, graph, vector, key/value — is a provider/Matching choice behind that one `data` abstraction**, recorded in `match.Decided`. Each paradigm is a provider implementation of `data`, not a separate top-level resource. **(Developer-facing evolution, [ADR-0081](#adr-0081)):** the generic `data` dep stays this **portable default**, but a developer may **opt into a paradigm package** (`@hobo/sql`/`vector`/`graph`/`document`) for Encore-style paradigm-idiomatic ergonomics — an idiom layer over this same taxonomy/port that maps to cloud natives via Matching and stays overridable. This adds a **typed package + candidate-native registration**; it does **not** change the `data`-not-`sql` default, move anything into core, or change graph/vector from opt-in **search extensions** ([ADR-0034](#adr-0034)) into defaults.
2. **Consistency is configurable per entity/materialization** via **Azure Cosmos DB-style tunable consistency levels** (strong, bounded-staleness, session, consistent-prefix, eventual). The **default is session consistency** (reads-your-writes within a Camp); an entity or materialization can dial up to bounded-staleness/strong (at higher latency/cost) or down to eventual (cheaper/faster) per its needs. The level is a `match.Decided` outcome and is honored by the reactor's snapshot@`seq` machinery ([Plan 32](../data-plane.md#plan-32)).
3. **The reactivity boundary, as one rule:** a projection is **reactive iff** its sink advertises the `change-feed` capability **or** it is the native log-backed projection; otherwise it is typed `reactive: false` and `hobo doctor` warns when a `"use query"` depends on it ([Plan 32](../data-plane.md#plan-32)'s existing check). Object-lake and OLAP sinks, and any non-deterministic search ([ADR-0034](#adr-0034)), are **off the reactive path by construction**.
4. **Portability is equivalence-class-bounded** ([Plan 4](../control-plane.md#plan-04)): "same Bindle, N backends" holds *within* a paradigm class (managed-relational, document, …). Cross-*paradigm* portability is **not** guaranteed — the schema mapping is paradigm-specific. Cross-engine *within* a class follows [Plan 32](../data-plane.md#plan-32)'s export→import.
5. **Each sink kind ships a `@hobo/conformance` suite:** claim a paradigm → round-trip a fixture record set, honor the declared consistency level, and, if reactive, emit ordered `data.Changed` ([Plan 20](../wasm-runtime-wit.md#plan-20)/[Plan 9](../generated-stack.md#plan-09)).

### Consequences
- **(+)** A data architect targets SQL, document, graph, lake, or OLAP behind one developer surface with the limits stated up front; per-entity tunable consistency (session default, CAP-honest), one memorable reactivity rule, and per-paradigm conformance keep adapters trustworthy.
- **(−)** Non-core paradigms (graph, OLAP, data-lake) need their adapters built and non-reactive paradigms split the developer mental model; equivalence-class bounding means a relational→document move is a re-model, not a config flip.

## ADR-0053
**CQRS is the opinionated app layer: commands, aggregates, and the actor boundary.**

### Context
[ADR-0050](#adr-0050) makes app domain data event-sourced (commands→events; backends are projections). Event-sourcing needs a **write-side consistency boundary**: a command must check invariants against current state and append without lost updates. `streamId` is the "aggregate/run/actor key" with optimistic `seq` ([Plan 11](../data-plane.md#plan-11)), and an `actor` is a "single-writer entity, state = folded event stream, lease + fencing" ([Plan 2](../sdk-api.md#plan-02)); these connect into one model with a clear write-side consistency guarantee, honest about CAP ([ADR-0040](01-architecture-core.md#adr-0040) rejects silent cross-store strong consistency).

### Decision
1. **CQRS is the opinionated app-layer implementation.** The app layer is **command/query-separated by default**: writes go through commands into aggregates (the write model); reads come from projections/materializations (the read model). This is the default app architecture, not one option among several.
2. **The command's consistency boundary is an aggregate, realized as an actor.** A `command` runs **inside** the single-writer boundary of the aggregate it targets (an [actor](../sdk-api.md#plan-02) keyed by the command's stream id): it loads the aggregate's **write-model fold** (`ctx.state`), checks invariants against current state, and emits events under the aggregate's **lease + fencing + optimistic `seq`** ([Plan 11](../data-plane.md#plan-11)). No new primitive — **an aggregate is an actor whose handlers emit domain events**, and `command` is the typed, domain-write sibling of an actor `signal`.
3. **Two folds, one log.** The **aggregate fold** is the authoritative *write* model (in the single-writer, for invariant checks); a **projection fold** ([Plan 32](../data-plane.md#plan-32)/[ADR-0050](#adr-0050)) is the *read* model (derived, in architect-chosen sinks). "Actor state = folded stream" and "projection = folded stream" are the same log, folded for two purposes.
4. **Per-aggregate serializability, not global.** Optimistic `seq` on the aggregate's stream gives serializable writes *within* an aggregate with **no global lock**. **Cross-aggregate** consistency is a **saga** (choreography + compensation, [Plan 2](../sdk-api.md#plan-02)) or eventual ([ADR-0040](01-architecture-core.md#adr-0040)); there is no silent distributed transaction across aggregates.
5. **`emit` stays for boundary-free facts.** A naked `ctx.emit` (no aggregate) is valid for domain events that need no invariant check (telemetry-like facts); the **default** domain write goes through a command→aggregate.

### Consequences
- **(+)** Invariants, concurrency, and "actor vs command" have one coherent answer — the aggregate/actor boundary — reusing existing primitives with no new mechanism; CQRS is the opinionated default (write fold vs read fold), serializable *per aggregate* without a global lock, sagas for cross-aggregate flows.
- **(−)** Developers must model aggregate boundaries (the classic DDD modeling cost), and multi-aggregate operations are eventually consistent / saga-coordinated, not atomic (a deliberate CAP choice, tunable per [ADR-0052](#adr-0052)).

## ADR-0032
**Data portability & schema-versioning strategy.**

### Context
HoBo's headline promise is "the same Bindle, N clouds." For *infrastructure* that holds (ports/adapters + the portability conformance guarantee, [ADR-0024](07-portability-extensibility.md#adr-0024)). For **application data** it must hold too: when a `sql` resource's schema changes, or it moves from one provider to another, the platform owns *who* runs the migration, *how* it is gated, and *how* data is carried across — in an event-sourced, gated, multi-cloud model, drawing on modern cross-DB migration practice.

### Decision
1. **Authoring = declarative desired-schema + auto-diff.** The developer declares the target schema (IfC); a diff engine computes a **reviewable migration plan** against the schema live in the target Camp. **Raw per-dialect SQL is an escape hatch**, not the primary surface. Relational `sql` ships with a Postgres reference.
2. **Schema versioning is contract-tested (PACT strategy).** Data/materialization schemas are versioned and **contract-tested like service boundaries** using the **PACT contract-testing versioning strategy** ([ADR-0051](#adr-0051)): consumer/provider expectations are pinned per version, so a change that would break a live consumer is caught before deploy.
3. **Apply = expand → backfill → contract**, each a **gated saga step** at Delta→Set/promote ([Plan 25](../platform-engineering.md#plan-25)). Only **contract** is destructive, and it composes with **`compat.Gate*`** ([Plan 29](../contracts-policy-flags.md#plan-29)) and the PACT contract: a drop that would break a still-running app/consumer version is **blocked**.
4. **Rollback = redeploy the last-good Set + restore a pre-contract snapshot.** Migrations are **forward-only — no `.down` scripts**; expand phases are additive, so an already-running app version keeps running, and a snapshot is taken before any destructive contract phase.
5. **Cross-cloud move = export→import within a provider equivalence class** (managed-Postgres), as a gated event-sourced saga with blue/green cutover ([Plan 5](../reliability-observability-cost.md#plan-05)) + checksum verification + source reap. Cross-engine moves use a CDC/dual-write adapter; portability is bounded to equivalence classes to keep the guarantee real.
6. **Events** `migration.Planned/SnapshotTaken/PhaseApplied/Verified/RolledBack/Failed` + move `migration.Exported/Imported/CutOver` — every step replayable/auditable.
7. **Layering & erasure.** This governs *application* data; the control-plane event log keeps its forward-only upcaster model ([Plan 11](../data-plane.md#plan-11)). Forward-only is the default but is configurable for GDPR / right-to-be-forgotten via crypto-shredding ([ADR-0051](#adr-0051)) — erasure anonymizes records by destroying forgetting keys rather than rewriting history.

### Consequences
- **(+)** The multi-cloud promise extends to **data**: schema evolution and intra-class moves are concrete, gated, contract-tested, and auditable, reusing existing machinery (Delta→Set + `can-deploy`, `compat.Gate*` + PACT contracts, blue/green + snapshots, the event log) so expand-contract gives safe zero-downtime, forward-only migrations and a clean rollback story without unreliable `.down` scripts.
- **(−)** A declarative diff engine is non-trivial and won't cover every DDL operation (the raw escape hatch is the pressure valve), and portability is bounded to equivalence classes — cross-engine moves go through CDC/dual-write.

## ADR-0034
**Search is the query side of the data plane — not a primitive; vector/graph are opt-in packages.**

### Context
Search is **not a standalone primitive**: it is the **query side of the data plane** ([ADR-0050](#adr-0050)/[Plan 32](../data-plane.md#plan-32)) — *how you read a `data` resource* — and it belongs in the data model, not as a separate top-level capability. Different modalities (full-text, vector/semantic, graph traversal, OWL/Semantic-Web reasoning) have their own semantics; baking any one into the core would over-commit it to a paradigm most apps don't use.

### Decision
1. **Search is the query side of `data`, merged into data modeling — there is no top-level `search()` primitive.** Reads over a `data` resource (the `view`/`repo`/`subscribe`/`query` surface, [Plan 32](../data-plane.md#plan-32)) carry a generic query/filter contract; **full-text query is the built-in query capability of `data`** (filters use the typed `eq`/`in`/`range` predicate DSL used elsewhere). `.allow()` verbs `read`/`query` are the data resource's, not a separate `search` resource's.
2. **Vector, graph, OWL/Semantic-Web, hybrid, etc. are opt-in extension *packages* — not built-in primitives.** Each adds a query modality to the data plane (a `search-extension` Matching dimension) with its own index declaration + operators. The **`@hobo/vector`** and **`@hobo/graph`** packages ([ADR-0081](#adr-0081)) are the developer-facing idiom layers — typed abstractions that map to cloud-native backends (Pinecone/OpenSearch/Azure AI Search · Neptune/Cosmos-Gremlin/Neo4j) selected by Matching and overridable. Vector is, precisely, *a specific kind of search behind its own package* — included only when the app adds the package. Hybrid (e.g. full-text + vector via reciprocal rank fusion) composes installed extensions on the read path.
3. **Declarative index declaration per modality** (full-text: fields + analyzer + prefix; vector extension: field + `dimensions` + filter fields; graph/OWL extensions: their own schema). An index *is* schema, so it flows through the gated **expand/backfill/contract** migration machinery ([Plan 32](../data-plane.md#plan-32)). Filters use the typed `eq`/`in`/`range` predicate DSL used elsewhere.
4. **Reactivity split by determinism:** deterministic search (full-text + filtered) are **reactive `query()`/`useQuery()`** citizens ([Plan 32](../data-plane.md#plan-32), re-push on `data.Changed`); non-deterministic modalities (vector embedding, external reasoners) run as a **`step`** off the reactive path; hybrid is a `step` fusing a reactive deterministic query with a non-deterministic extension.
5. **An `embed` capability** (`hobo:embed`) for the vector extension auto-embeds rows + text queries, brokered secretlessly ([Plan 6](../ai-native-agent-auth.md#plan-06)/[Plan 21](../authoring-resources-wiring.md#plan-21)) and realized **per Camp** (local/in-boundary model for dev/air-gap; hosted API for prod), Matching-selected. **BYO precomputed vectors** is the escape hatch. The pgvector + local-model path is a complete, no-egress option — portability is never gated behind a paid embedder.
6. **No new event types** — reuse `query.*` + `data.Changed`, `migration.*`, and `run.StepCompleted`.

### Consequences
- **(+)** A portable, reactive-where-it-can-be, paradigm-agnostic search surface (full-text in the core, vector/graph/OWL as opt-in extensions) reusing ports/adapters + Matching, the migration machinery, the reactive reactor, and secretless auth, with the local-model `embed` adapter giving an air-gap-friendly, no-egress option.
- **(−)** A generic port plus per-modality extensions means a broad conformance surface with ongoing equivalence-class fidelity work, and an embedding-model change is itself an index migration (re-embed) — correct but operationally heavy.

## ADR-0059
**App communications: the `notify` family over the shared receiver port.**

### Context
HoBo messages *operators* (ops alerting, [ADR-0045](02-identity-security.md#adr-0045)) and moves messages *between services* (`topic`/`queue`, [Plan 21](../authoring-resources-wiring.md#plan-21)). A developer's app also needs a first-class, portable, secretless, auditable way to send a verify-email, an OTP SMS, a push, or an outbound webhook to *its* users/customers. Bolting this on per-provider would reintroduce static API keys, untyped payloads, no consent enforcement, and no delivery audit — exactly the anti-patterns HoBo's planes exist to remove.

### Decision
1. **One `notify` capability behind a single `hobo:notify` port.** The capability is **`notify`** in general; **`email`/`sms`/`push`/`webhookOut` are channel *types* of notification under that one capability**, not separate top-level resources. Calling `.send(...)` infers the `send` grant (an explicit `.allow("send")` only narrows); the channel is a typed parameter of the send. Providers (SES/SendGrid/Twilio/FCM/APNs/signed-webhook) are per-channel **secretless-brokered adapters** ([Plan 6](../ai-native-agent-auth.md#plan-06)/[Plan 21](../authoring-resources-wiring.md#plan-21)) behind the shared port, selected via Matching.
2. **One port, two consumers.** App communications **reuses the ADR-0045 receiver port + adapters**; ops alerting and app comms are the same transport with different policy/audit/addressing. A provider adapter is written once and serves both.
3. **Recipients are `PrincipalRef`s** ([Plan 6](../ai-native-agent-auth.md#plan-06)) and **templates are WIT records** ([ADR-0051](#adr-0051)) — identity/consent and typed payloads ride the existing models; `send` is a memoized `step` (idempotent, no double-send on retry).
4. **Sends are event-sourced** (`notification.Requested/Sent/Delivered/Bounced/Failed`) → auditable, reactive (`useQuery()` delivery status, [Plan 32](../data-plane.md#plan-32)), and retry/compensatable ([Plan 5](../reliability-observability-cost.md#plan-05)).
5. **Policy-gated** ([Plan 29](../contracts-policy-flags.md#plan-29)): rate limits and quiet-hours are `policy.Decided`/obligations (deferral is a durable effect, not advice); **consent/opt-out** is a generic policy-obligation example — not a product feature.
6. **Idempotency reaches the provider, and the audit trail is erasable.** Memoizing the `step` stops *HoBo* re-issuing, but a lost-response retry could still double-send at the **provider** — so the send **forwards a stable idempotency key to the provider** (the standard provider idempotency-key header), making at-least-once delivery exactly-once *end-to-end* where the provider supports it (and the caveat surfaces in the adapter capability where it doesn't). And because a recipient address is PII, **`notification.*` events store the recipient as a crypto-shreddable reference** ([ADR-0051](#adr-0051)) — the address is encrypted under the subject's forgetting key (or a `PrincipalRef` whose contact fields are `forgettable`), so a right-to-erasure shred **anonymizes the "who did we contact" trail too**, instead of leaving plaintext addresses un-erasable in an append-only log.

### Consequences
- **(+)** A common SaaS gap is closed with almost no new machinery — one port + one event family + catalog rows riding the existing receiver port, broker, log, and policy plane — secretless + typed + consent-gated + auditable by default, with reactive delivery status and air-gap-friendly degradation to in-boundary SMTP/relay.
- **(−)** Provider deliverability nuances (warmup, DKIM/SPF, carrier rules) live in adapters (HoBo standardizes the *contract*, not every provider's quirks), and consent/preference modeling carries a choice each app makes explicitly.

## ADR-0081
**Encore-style paradigm resource packages as opt-in SDK plugins (SQL · vector · graph · document), mapped to cloud natives by Matching, overridable.**

### Context
[ADR-0052](#adr-0052) makes the app-level data dependency a **single generic `data` dep** (explicitly *not* `sql`), with the paradigm chosen by Matching behind one `hobo:projection` port — the **portable default** — and scopes graph/document/vector as adapters/extensions behind the port. Developers coming from Encore (`new SQLDatabase(...)`), Mongo, a graph DB, or a vector store want **paradigm-idiomatic, typed ergonomics** *on purpose*; Encore's abstraction is **Postgres-only with a fixed compiler mapping** you can't redirect ([`docs/competitors/encore`](../../competitors/encore.md)). HoBo offers Encore's ergonomics **across more paradigms**, with **Matching-selected cloud natives** (not a fixed mapping) that stay **overridable** — developer-facing **opt-in paradigm packages** over the [ADR-0052](#adr-0052) taxonomy, with graph/document/vector as first-class opt-in.

### Decision
1. **Opt-in paradigm packages are idiom layers over the existing ports — the generic `data` dep stays the default — and the *capability* always lives in WIT, never in the package.** [ADR-0052](#adr-0052)'s generic, paradigm-agnostic **`data`** remains the **portable default** (Matching picks the paradigm). On top of it, a developer may **opt into a paradigm package** — **`@hobo/sql`** (relational), **`@hobo/vector`** (ANN search), **`@hobo/graph`** (graph/traversal), **`@hobo/document`** (NoSQL/document) — each a **typed, paradigm-idiomatic abstraction** that **lowers to a WIT port + Manifest IR** ([ADR-0050](#adr-0050)/[ADR-0034](#adr-0034)). Per the idiom-layer rule ([ADR-0072](01-architecture-core.md#adr-0072) §4) the guarantee is **lowering-equivalence + an enumerated semantics annex, *not* "adds no semantics,"** and a package that needs a genuinely new capability **must add it to WIT first** — so the two kinds of package are distinct: **`@hobo/sql` and `@hobo/document` are pure idiom layers over the `hobo:projection` port** (sugar over capability that already exists), while **`@hobo/vector` and `@hobo/graph` are idiom layers over the `hobo:search` *extension capabilities*** ([ADR-0034](#adr-0034)) — the ANN/traversal operations the generic `data` surface lacks live **in the WIT search extension (the port), not in the package**. Either way the package holds **no cloud logic** (thin-SDK, [ADR-0069](01-architecture-core.md#adr-0069)); it is the **opt-in specialization** for devs who want the paradigm's idioms, and does not change ADR-0052's "`data`, not `sql`" default.
2. **Opting in is a deliberate, surfaced specialization — and the portability guarantee differs sharply by paradigm.** A paradigm package is a **conscious choice of a paradigm + its idioms**, so its portability is **honest per paradigm, not a blanket "portable within class":**
   - **`@hobo/sql`** is portable only **within the managed-Postgres equivalence class** (RDS / Azure DB for Postgres / Cloud SQL / Neon — exactly [ADR-0052](#adr-0052) §4 / [ADR-0032](#adr-0032) §5). **SQL Server and MySQL are *separate* engine classes** (different dialect/types/semantics) reachable only by **`.with()` pinning** or the **CDC/dual-write cross-engine path** ([ADR-0032](#adr-0032) §5) — pinning one **forfeits within-class portability** (engine lock-in, surfaced as debt). Neon is managed Postgres, not a second engine.
   - **`@hobo/document`** is portable within the document class only where the chosen natives share semantics (Mongo-API engines); cross-document differences are surfaced like relational.
   - **`@hobo/vector` and `@hobo/graph` carry *no* portability-within-class guarantee** — pgvector vs Pinecone vs OpenSearch (index types/filter/recall) and Gremlin vs Cypher vs SPARQL are **not mechanically substitutable**; each native is effectively its own class. The package gives **idiom-level *source* portability** (the same WIT-typed surface) but **not** the "same Bindle, N backends" *runtime* guarantee that managed-Postgres/document enjoy. This is stated, not borrowed from §4.
   All of the above is **surfaced** in the PortabilityReport ([ADR-0024](07-portability-extensibility.md#adr-0024)) — opt-in specialization, never hidden; `hobo doctor` notes the paradigm/engine-specific surface.
3. **Intelligent default cloud-native selection via Matching/the Dispatcher — not a fixed mapping (the Encore gap, closed).** Candidate cloud-native adapters per provider are **registered as a `projection-sink`/`search-extension` Matching dimension** ([ADR-0052](#adr-0052)/[ADR-0034](#adr-0034)) — by **provider-adapter packages** and **AI-generated adapters** ([ADR-0033](01-architecture-core.md#adr-0033)/[Plan 23](../generated-stack.md#plan-23)), not hand-wired into a compiler. Examples: relational → managed-Postgres (RDS/Azure Postgres/Cloud SQL/Neon) + the separate SQL Server/MySQL engine classes (§2); vector → pgvector/OpenSearch/Azure AI Search/Pinecone/Turbopuffer; graph → Neptune/Cosmos-Gremlin/Neo4j-Aura; document → DynamoDB/Cosmos/Firestore/MongoDB-Atlas. On deploy the existing **Matching pipeline** ([ADR-0033](01-architecture-core.md#adr-0033)) deterministically selects the best-fit native per Camp/provider against the objective (cost/latency/single-provider/carbon) + capability `require`/`prefer`, recorded in **`match.Decided`**; the **Dispatcher** ([ADR-0071](01-architecture-core.md#adr-0071)) can cost-route it. **No native for the paradigm on the resolved provider is handled by that same pipeline, not hand-waved:** it is a `require`-miss → **`deployment.PlanRejected`** with a precise, agent-correctable reason — *unless* the paradigm can degrade to the **native log-backed projection** ([ADR-0050](#adr-0050)), in which case it falls back with a **`PlanWarning`** (e.g. a small relational/document workload served by the native sink). "Intelligently selected by default" = this deterministic, auditable pipeline — *not* Encore's fixed compiler mapping.
4. **Always overridable — three escape-hatch levels.** (a) **Pin the native** with `.with(provider.native())` ([ADR-0007](01-architecture-core.md#adr-0007)) — e.g. force Azure SQL Server, or Pinecone for vector; (b) **override the mapping** with a platform-engineer **Resource Definition** ([ADR-0033](01-architecture-core.md#adr-0033)), per environment; (c) **drop to dialect** with `.raw(driver => …)` ([Plan 32](../data-plane.md#plan-32)) for engine-specific reads — but note `.raw` is **read-only on a projected paradigm sink** (a derived sink must not diverge from the log); engine-specific **writes** require an **authoritative-external (adopted) store** ([ADR-0041](07-portability-extensibility.md#adr-0041)). All are flagged as portability (and, in a multi-tenant pooled store, tenant-isolation, [ADR-0080](02-identity-security.md#adr-0080)) debt. The default is intelligent + portable per §2; the override path is first-class and surfaced.
5. **One canonical schema across paradigms — shared *type*, not a free swap.** Every paradigm package types its records/documents/nodes-edges/vector payloads from the **WIT-record canonical domain schema** ([ADR-0051](#adr-0051)), so types + codegen ([ADR-0037](01-architecture-core.md#adr-0037)) stay consistent. But a **paradigm swap reuses the type definition and still requires a new mapping** (fields→columns vs nodes+edges vs vector+filters) — cross-paradigm is a **re-model, not a config flip** ([ADR-0052](#adr-0052) §4 / the data-plane Non-goal). Sharing the type makes codegen consistent; it does not make the swap cheap.
6. **Honest paradigm semantics.** Reactivity follows the canonical rule ([ADR-0052](#adr-0052) §3): a sink is reactive **iff** it advertises `change-feed` **or** is the native log-backed projection. So relational/document reactivity is **per-adapter** (Postgres logical-replication and Mongo change-streams: reactive; DynamoDB-Streams/Firestore: partial/differently-shaped — `hobo doctor` reports each), and **`@hobo/vector`/`@hobo/graph` search are `step`s** (external/non-deterministic) typed `reactive: false`, off the reactive path. Each paradigm package + each per-provider native adapter ships a **`@hobo/conformance` suite** (round-trip a fixture set, honor the declared consistency level, and if reactive emit ordered `data.Changed`); cross-paradigm queries are not free.

### Consequences
- **(+)** Encore's resource-abstraction DX across **SQL + vector + graph + document** with **intelligent, auditable, overridable** default native selection, reusing the taxonomy, ports, Matching/Dispatcher, idiom-layer, canonical schema, and codegen with **no new runtime** — `@hobo/vector`/`@hobo/graph` stay opt-in *search extensions* and `@hobo/document`/`@hobo/sql` wrap core projection-sink paradigms.
- **(−)** Each paradigm package + its per-provider native adapters is a maintained, conformance-covered surface, and paradigm-specific surfaces are equivalence-class-bounded — cross-paradigm portability isn't free (stated + surfaced in the PortabilityReport).

## ADR-0010
**AI generation pipeline: providers and implementations generated, repaired, and certified against conformance.**

### Context
Provider/implementation breadth is a community bottleneck. The generation pipeline breaks it by **synthesizing** candidates and **certifying** them against a conformance trust boundary ([Plan 6](../ai-native-agent-auth.md#plan-06), [Plan 9](../generated-stack.md#plan-09)). This ADR defines both *what* the pipeline produces and *how* a candidate is synthesized, repaired, and made reproducible/trustworthy — so "generate a provider" is concrete.

### Decision
1. **Algorithm = template scaffold + LLM-fill + a conformance/trace-driven repair loop**, and the repair loop **reuses the `training-engine` optimizer** (OPTO/Trace, [ADR-0025](#adr-0025)) rather than a separate generator. Generation (cold-start) and live training ([Plan 23](../generated-stack.md#plan-23)) are the two entry points of one engine.
2. **Inputs are contract-first.** The target **WIT port + its `@hobo/conformance` suite + the backend's Capability Manifest** are *authoritative*; provider docs/OpenAPI/Terraform and recorded stub/live traces are *material* (synthesis hints + behavioral oracle). **The primary injection defense is structural — the contract can't be overridden + the no-egress sandbox (point 3) bounds damage**; doc-scrubbing ([ADR-0023](02-identity-security.md#adr-0023)) is **best-effort defense-in-depth**, not a claim that natural-language injection is prevented. Material can never override the contract.
3. **The loop is generate → validate(sandboxed, no-egress) → repair(bounded budget; exhaustion → `gen.NeedsHuman`) → certify.** Certification **signs + pins provenance** (model, frozen prompt, seed, conformance report) and **promotes via the policy gate**: low-risk auto-certify, prod/high-trust human approval. **The generated artifact's dependency closure passes the supply-chain gate** (SBOM + CVSS≥7 block + SLSA signing, [ADR-0023](02-identity-security.md#adr-0023) §7) as a **certification precondition** — an LLM-chosen vulnerable transitive dep that passes conformance still fails certification. **Reproducibility is stated honestly:** certification is **re-verifiable** (conformance replays green), but **bit-reproduction of generation is guaranteed only for pinned-weights/self-hosted models** — for hosted LLM endpoints (silent weight updates behind an alias, non-deterministic seeds) repro is **best-effort**, and re-verification, not bit-repro, is the trust anchor.
4. **One pipeline for three artifact kinds** — providers, implementations, and Resource Definitions/Packs — all behind existing WIT ports + the conformance boundary.
5. **Events** `gen.Requested/CandidateGenerated/Validated/ValidationFailed/Repaired/NeedsHuman/Certified` make every step replayable/auditable.

### Consequences
- **(+)** Provider/impl/definition generation is a concrete, bounded, auditable loop reusing the conformance trust boundary, the Firecracker+wasm no-egress sandbox, and the training-engine.
- **(−)** Quality relies on a strong conformance suite, template library, and optimizer; cold-start from docs-only is the riskiest path and a repair budget trades thoroughness for cost.

## ADR-0014
**MCP as a first-class control surface.**

**Decision:** every CLI/SDK capability has an MCP equivalent with the same identity model. **Consequences:** agents are true operators; HoBo maintains a third interface surface in lockstep ([Plan 6](../ai-native-agent-auth.md#plan-06), [Plan 7](../developer-experience.md#plan-07)).

## ADR-0025
**`"use training"` directive + `training-engine` behind a port (Agent Lightning / Trace optional, internal-only).**

### Context
HoBo lets AI implement, evolve, and live-fix WIT-port implementations ([Plan 23](../generated-stack.md#plan-23)). A Vercel-Workflows-style directive — peer to `"use workflow"`/`"use step"` ([Plan 2](../sdk-api.md#plan-02)) — declares a method **AI-rewritable**, with optimization machinery modeled on proven frameworks (Microsoft [Trace](https://microsoft.github.io/Trace/), [Agent Lightning](https://microsoft.github.io/agent-lightning/stable/)) **without leaking those frameworks (or any ML/RL machinery) into the SDK surface** — the same separation HoBo enforces for Pact/OPA/Cedar ([ADR-0015](02-identity-security.md#adr-0015)).

### Decision
1. **`"use training"` is the SDK directive** (with an equivalent `training(fn, opts)` wrapper) marking a method as an **AI-rewritable semantic function**. The body is the baseline (often a `stub()`); HoBo may rewrite its prompt/code. It composes with the existing semantic-function model — Contract/Eval/Policy/Trace and the gated promotion are unchanged.
2. **Rewritability requires semantic grounding.** A `"use training"` method must carry **intent (docstring/`@intent`) + contract (typed I/O + invariants + forbidden outputs) + rubric**; HoBo lints for their presence. These are the optimizer's instruction, hard boundary, and objective respectively.
3. **The optimizer is an engine behind a `training-engine` WIT port** ([Plan 20](../wasm-runtime-wit.md#plan-20)) with a **built-in default** (an OPTO/prompt-rewrite optimizer). **Microsoft Agent Lightning (`@hobo/provider-agent-lightning`) and Microsoft Trace (`@hobo/provider-trace`) are optional adapters behind that port, selected per tenant/Camp, and are NEVER part of the SDK surface.** SDK users never import or configure them; swapping the optimizer is a config change, not an app-code change.
   - **From Trace:** treat the graph of trainable methods as an optimizable computational graph; feedback propagates back and rewrites trainable parameters in place (OPTO).
   - **From Agent Lightning:** decouple execution from training — the running method emits trajectories; a separate trainer/store optimizes via RL (GRPO/PPO), APO, or SFT. This mirrors HoBo's data-plane/control-plane split.
4. **Runtime capture = OTel + OpenInference.** Each invocation emits OpenInference-convention spans (layered on existing OTel, [Plan 5](../reliability-observability-cost.md#plan-05)); a *trajectory* (span tree + I/O + reward + correlation) is the training-data unit, persisted via the event log. **PII in trajectories is resolved explicitly** (reconciling [ADR-0023](02-identity-security.md#adr-0023) §8 "redact at capture" with trajectory storage): trajectories are **redacted/tokenized at capture** by default so cleartext PII never enters the log; where the optimizer/judge genuinely needs raw text, it reads it only via a **policy-gated in-boundary decryption**, and **external optimizer/judge providers (Agent Lightning/Trace) are barred from PII-classified content** — they receive redacted trajectories (accepting the capability tradeoff), never decrypted PII.
5. **Live-evals are the training signal.** Rubrics scored online on live/shadow traffic attach the reward each trajectory needs **and** serve as performance telemetry; they are the optimizer's objective and feed the promotion gate.
6. **No new trust path — and the gate bounds reward-hacking.** A trained candidate goes through the **same gate** as any generation pipeline impl: sandboxed conformance (contract) + eval thresholds + policy + champion/challenger/shadow. Because an optimizer can **game a flawed proxy reward** (maximize the LLM-judge score while degrading real quality), rubric-presence lint (point 2) is **necessary but not sufficient**: the eval gate requires a **held-out / adversarial eval split + a judge-independence (or human-label sampling) floor** as **hard terms** — a candidate that beats the training judge but fails the held-out/independent check does **not** promote. Every step is an event (`training.*`, `eval.*`, `impl.Promoted`).

### Consequences
- **(+)** Developers get a one-word, intent-revealing way to opt a method into continuous improvement grounded in real recorded execution (OpenInference trajectories), with the hard ML/RL parts internal, swappable, and gated by the existing conformance/eval/policy machinery.
- **(−)** A rewritable method that lacks good intent/rubric optimizes poorly (hence the lint requirement), and online eval + trajectory storage add runtime cost.

## ADR-0048
**Persisted code-mutation mechanism (for `"use training"` promotion).**

### Context
[Plan 23](../generated-stack.md#plan-23) + [ADR-0025](#adr-0025): the `training-engine` continuously rewrites `"use training"` semantic functions (prompt/code) and, when a candidate passes eval/conformance, **promotes** it. "Promote" needs a concrete, safe **persistence mechanism** — how a generated mutation lands back in source without clobbering hand-written code, with provenance and review. The [runtime-code-mutation-persistence pattern](../../patterns/runtime-code-mutation-persistence.md) (ts-morph / recast / jscodeshift / magic-string + unified-diff apply) is the toolbox.

### Decision
1. **Promotion persists via AST-aware, region-scoped edits — never blind string patches.** A promoted candidate is applied with an **AST/codemod tool** (recast/ts-morph-style, format-preserving) confined to a **clearly demarcated generated region** of the `"use training"` method (the prompt/body the engine owns), leaving hand-written code untouched. Output is a minimal, format-preserving diff.
2. **Generated vs hand-written is explicit.** A `"use training"` method's optimizable region is marked (a directive boundary) so codegen/promotion only ever rewrites inside it — the same generated-vs-authored distinction as the `_generated/` codegen surface ([ADR-0037](01-architecture-core.md#adr-0037)); promoted regions carry a header noting they're engine-managed + their provenance id.
3. **Provenance-pinned + gated, as a reviewable change — subordinate to org governance.** A promotion emits the existing `training.Promoted`/`impl.Promoted` events ([Plan 11](../data-plane.md#plan-11)) carrying **signed provenance** (model, prompt, seed, eval/conformance report — the same trust boundary as generation pipeline, [Plan 23](../generated-stack.md#plan-23)). The persisted mutation lands as a **gated change** ([Plan 29](../contracts-policy-flags.md#plan-29)): low-risk → auto-commit to the generated region with provenance; prod/high-trust → **open a PR/Delta for human approval**. The auto-commit-vs-PR risk tier is **itself a `hobo:*` control-plane action subordinate to the [ADR-0074](02-identity-security.md#adr-0074) mandatory-policy-rule (deny-ceiling)** — an org `mandatory` "2-person approval for prod code/prompt changes" or "no auto-commit in prod" **overrides** the risk-tier default (the SWE/SRE operator is an RBAC principal that can't exceed its role), so risk-tiering never silently bypasses an org deny-ceiling.
4. **Idempotent + round-trippable.** Re-applying the same candidate is a no-op (like `codegen --check`, [ADR-0037](01-architecture-core.md#adr-0037)); the prior region is recoverable (the event log holds every candidate), so a promotion is reversible by re-promoting the previous one.

### Consequences
- **(+)** `"use training"` promotion has a concrete, safe persistence path — AST-aware, region-scoped, provenance-pinned, gated, idempotent — keeping running behavior in VCS (auditable, reviewable, replayable) and reusing the generation pipeline trust boundary + policy gate + GitOps/PR machinery.
- **(−)** AST codemod fidelity across TS constructs is non-trivial and the generated-region boundary is a discipline authors must respect; a human edit *inside* a generated region is a **collision** resolved by `--check` refusing to auto-commit and escalating to a PR (never clobbering the hand edit).

## ADR-0054
**Operator Agents (the Crew): built-in autonomous Yard services.**

### Context
HoBo treats agents as first-class principals ([Plan 6](../ai-native-agent-auth.md#plan-06)), exposes every capability over MCP, and has the operational substrate (live-fix, drift/auto-rollback, pipelines, SLO/alerting, observability projections, generation pipeline, Matching, app generation). The Crew is the **named set of operator agents** that *use* that substrate to run the platform — the concrete form of the "AI SRE / AI GitOps / AI policy enforcement / AI software & UX" goals. "Agent" means an autonomous principal; the outbound network proxy is the **Relay** ([Plan 25](../platform-engineering.md#plan-25)).

### Decision
1. **Ship a built-in roster — the Crew** as **first-class Yard services**, batteries-included but **pluggable** (each disableable/overridable per Yard; each brain is an **engine behind a port** with a built-in default + optional external providers):
   - **SRE** → live-fix + observability + drift/auto-rollback ([Plan 40](../operators-sre.md#plan-40)/[Plan 40](../operators-sre.md#plan-40)).
   - **Endpoint Monitor** → synthetic probes + SLO/alerting.
   - **GitOps** → pipelines + can-deploy promotion.
   - **Platform Engineer** → Matching + packs + generation pipeline (authors Resource Definitions/policy packs).
   - **UX Designer** → app/UI generation ([ADR-0056](#adr-0056)): owns **design.md** (the required design-system spec), drives **OpenUI** + **json-render** + **mcp-apps**, and renders against the `ui-render` port; reactive to the data plane's materializations.
   - **SWE (software engineer)** → a general software-engineering operator: implements/refactors/repairs **business + message** code behind ports, drives the generation pipeline + `"use training"` loop and persisted code-mutation ([ADR-0048](#adr-0048)), opens gated Deltas/PRs. The generalist counterpart to the specialist operators.
   - **FinOps** → cost forecasts + anomaly signals + commitment/optimization recommendations, advisory-only via gated Deltas ([ADR-0117](#adr-0117)).
2. **Each operator is a named principal on the existing model** ([Plan 6](../ai-native-agent-auth.md#plan-06)): SVID identity, per-agent policy + spend caps, event-sourced runs, MCP surface, least-privilege `.allow()`. No new identity/policy mechanism — the roster *is* the agent-principal model applied to operations.
3. **Reads are autonomous; writes are policy-gated** ([Plan 29](../contracts-policy-flags.md#plan-29)): diagnosis/monitoring run freely; mutations take an effect/obligation (auto / canary-with-auto-rollback / require-approval) keyed by blast radius + environment ([Plan 5](../reliability-observability-cost.md#plan-05)).
4. **All operators run sandboxed under enforced AI governance by default** ([ADR-0061](02-identity-security.md#adr-0061)): every operator (its reasoning + tool calls) executes in a sandboxed environment with **NVIDIA NeMo Guardrails** and the **Microsoft AI governance / Responsible AI toolkit** enforced as the default guardrail layer — moderation, jailbreak/PII checks, and capability-scoped tool access. This is enforced, not opt-in.
5. **Operators compose existing subsystems, they don't reinvent them.** External brains (e.g. HolmesGPT for SRE) sit behind ports. Events: a thin `crew.*` family + reuse of existing `run.*`/`incident.*`/`pipeline.*`/`policy.Decided`.

### Consequences
- **(+)** Delivers "AI SRE / AI GitOps / AI policy enforcement" concretely, reusing the principal/policy/event/MCP substrate — audited, policy-gated, replayable, and pluggable (swap an engine, disable an operator, or BYO; air-gap-friendly).
- **(−)** Autonomous operators acting on prod are a trust surface; bounded by org RBAC, sandbox-lane write-experiments before any canary, default-gated writes, spend caps, dispatch/handoff-depth caps + flapping debounce, blast-radius limits, and full audit.

## ADR-0055
**The generated stack: a layered model for AI generation/self-healing/persistence.**

### Context
HoBo's AI-native capabilities span several layers: data-plane materializations ([Plan 32](../data-plane.md#plan-32)), AI-generated providers/impls ([Plan 23](../generated-stack.md#plan-23)), trainable semantic functions ([Plan 23](../generated-stack.md#plan-23)), persisted mutation ([ADR-0048](#adr-0048)), and app/UI generation ([ADR-0056](#adr-0056)). These share one loop, one log, one trust boundary, and one persistence mechanism. A unifying model makes the promise legible across the whole stack — from infrastructure up to the app's UI.

### Decision
1. **Adopt a five-layer taxonomy for generation: data · business · message · intelligence · ui.** It is a *map over existing mechanisms*, not new runtime: each layer names what HoBo generates, who owns it, how it self-heals, and how it persists. The **ui** layer ([ADR-0056](#adr-0056)) is generated from intent + **design.md** via OpenUI/json-render/mcp-apps, owned by the **UX Designer** operator, and reactive to the data plane's materializations.
2. **One generation loop across layers** — the generation loop (scaffold → LLM-fill → validate-sandboxed → repair → certify) ([Plan 23](../generated-stack.md#plan-23)); only inputs/oracles differ per layer.
3. **One trust boundary** — nothing generated is trusted without conformance + policy + eval ([Plan 9](../generated-stack.md#plan-09)/[Plan 29](../contracts-policy-flags.md#plan-29)/[Plan 29](../contracts-policy-flags.md#plan-29)); **one persistence mechanism** — region-scoped AST edits + provenance ([ADR-0048](#adr-0048)), generated regions demarcated, hand-written intent never clobbered, drift-gated ([ADR-0037](01-architecture-core.md#adr-0037)).
4. **One self-healing reflex, with an explicit per-layer auto-fix-eligibility flag** — classify → propose-fix → validate → gated-apply (live-fix [Plan 23](../generated-stack.md#plan-23) + drift/auto-rollback [Plan 5](../reliability-observability-cost.md#plan-05)), driven by the **SRE** and **SWE** operators ([Plan 40](../operators-sre.md#plan-40)). "Degrades to propose" is not left to operator judgment — each layer carries a declared **`autoFixEligible`** attribute the policy plane enforces ([Plan 29](../contracts-policy-flags.md#plan-29)): **data and business are auto-fix-eligible** (a deterministic, contract-gated, reversible fix may auto-apply behind a canary + auto-rollback), while **message and ui are propose-only** (the SWE/UX-Designer operator may only open a gated Delta/PR — never auto-apply) because their correctness oracle is weaker (no hard conformance over choreography side-effects or free-text design prose, [ADR-0056](#adr-0056) §2). A layer with no strong oracle **cannot be flipped to auto-apply by config** — it is a guardrail ([ADR-0074](02-identity-security.md#adr-0074)), so a mis-set Resource Definition can't silently start auto-mutating UI/message code.
5. **Message is a first-class generated layer:** message-handler/choreography generation from WIT-record event types.

### Consequences
- **(+)** Makes the AI-native promise legible end-to-end — infrastructure through UI — reusing one loop/boundary/persistence across all layers, giving the operator agents ([Plan 40](../operators-sre.md#plan-40)) a clear per-layer remit with a consistent safety story (deterministic codegen reproducible; non-deterministic promotions region-isolated, provenance-pinned, prod-gated).
- **(−)** Uniform framing can over-promise: layers self-heal unequally; the docs state this explicitly to avoid implying message/ui heal as maturely as data/business.

## ADR-0056
**App/UI generation (design.md · OpenUI · json-render · mcp-apps · the `ui-render` port).**

### Context
The AI-native thesis is to generate the application from intent — not only its infrastructure but its **UI**. HoBo generates data/business/message/intelligence layers ([ADR-0055](#adr-0055)); the **ui** layer needs a concrete mechanism, an owner, and a trust boundary, distinct from HoBo's own operator dashboard ([Plan 7](../developer-experience.md#plan-07)).

### Decision
1. **`ui-render` is a port** with pluggable engine adapters: **OpenUI** (generate UI from intent) and **json-render** (a declarative render IR), plus **mcp-apps** (MCP-driven app surfaces) so agents can drive and inspect the UI like any other capability. Custom adapters plug in behind the same port.
2. **`design.md` is a required input** — the design-system spec (tokens, components, layout constraints, a11y rules) that HoBo generates and then **enforces**. The enforcement is honest about what's mechanically checkable: its **machine-checkable subset — design tokens, a11y rules, an allowed-component allowlist — is a hard gate** (UI violating it fails); prose layout/aesthetic constraints are **advisory** (LLM-judged, not a hard oracle). So it is conformance-*like* for the checkable subset, not full conformance-parity over free-text design prose.
3. **The UX Designer operator owns it** ([ADR-0054](#adr-0054)): it generates/maintains the UI against design.md, runs sandboxed under enforced AI governance ([ADR-0061](02-identity-security.md#adr-0061)), and lands changes via the same persisted-mutation + policy gate as any generated code ([ADR-0048](#adr-0048)).
4. **Generated UI is typed from the domain + reactive to materializations.** Components are typed from the WIT-record domain schema ([ADR-0051](#adr-0051)) and bind to the data plane's reactive materializations / GraphQL facade ([ADR-0050](#adr-0050)), so the UI updates as state changes.

### Consequences
- **(+)** Completes the generated stack up to the UI — the app (infra and front-end) is generatable from intent, design-constrained, typed, and reactive — reusing the existing generation loop, trust boundary, persisted-mutation, and operator/governance machinery (a port + design.md, not a new plane).
- **(−)** UI quality depends on the engine + design.md fidelity; weak design specs yield weak UI.

## ADR-0058
**SRE: incident management, runbooks & the self-healing decision model.**

### Context
HoBo has alerting/SLO ([ADR-0045](02-identity-security.md#adr-0045)), pipelines ([Plan 25](../platform-engineering.md#plan-25)), AI live-fix ([Plan 23](../generated-stack.md#plan-23)), drift + auto-rollback ([Plan 5](../reliability-observability-cost.md#plan-05)), and chaos ([ADR-0047](02-identity-security.md#adr-0047)) — strong reflexes. The **management** layer over them covers `incident.*`, a runtime + contract failure taxonomy, the SRE operator's decision logic, first-class **runbooks**, MTTD/MTTR, on-call/escalation, postmortems, and obligation deadlines/escalation.

### Decision
1. **Incident is a first-class aggregate** ([ADR-0053](#adr-0053)): stream `incident:<id>`, single-writer, rebuildable, correlating loose signals (`alert.*`/`slo.BudgetBurned`/`resource.DriftDetected`/`compat.GateFailed`/`spend.CircuitTripped`) into one command point. The **`incident.*`** events are `Opened`/`Triaged`/`RootCauseIdentified`/`RemediationProposed`/`RemediationApplied`/`RemediationFailed`/`Resolved`/`SLABreached`/`PostmortemFiled`.
2. **The SRE operator runs a documented decision tree:** diagnose (projections; optional HolmesGPT behind a port) → classify → **auto-fix** (low-risk/reversible/in-budget/conformance-green) | **propose** (gated Delta/PR) | **escalate** (page on-call). **An auto-fix is *first* proved in a strictly-isolated [ADR-0076](02-identity-security.md#adr-0076) sandbox lane (R7) — not applied directly to a baseline service** — and only then promoted via the live-fix canary + auto-rollback; if the candidate can't be lane-contained (e.g. it needs a baseline lease), it routes to an ephemeral-Camp clone or degrades to *propose*. The "low-risk auto" threshold thus governs **lane → canary** promotion, never unguarded prod edits. Every branch is `crew.*` + `policy.Decided` + `incident.*` — replayable; no silent action on unclassifiable failures. A **per-incident/per-signal dispatch + handoff-depth cap + flapping debounce** bounds a runaway operator loop (re-dispatch/`crew.HandoffRequested` churn) that spend-caps ([ADR-0054](#adr-0054)) wouldn't catch.
3. **One runtime failure-taxonomy → safe-fix map** unifies Plan 5 runtime classes + Plan 23/29 contract classes; **live-fix applies, the taxonomy classifies**; every strategy is reversible + gated.
4. **Runbooks are first-class, declarative, event-sourced** (`runbook.*`), versioned/signed like Resource Packs, **built on the Pipelines engine** ([Plan 25](../platform-engineering.md#plan-25)) as the incident-response sibling of deploy pipelines; HolmesGPT/StackStorm are optional engines behind the port.
5. **MTTD/MTTR are OpenSLO SLOs** with error budgets that gate (burn → freeze risky deploys / require postmortem); **on-call escalation is a policy obligation with a deadline** (resolves the Plan 30 hook); **postmortems are generated by replay** and feed gated runbook/prompt updates.

### Consequences
- **(+)** A coherent, auditable incident-management story (one aggregate + two event families + a taxonomy table + runbooks-on-pipelines), where postmortem-as-replay + failure→regression-test make incidents a learning loop and engines behind ports (HolmesGPT/StackStorm/pagers) keep it pluggable and air-gap-friendly.
- **(−)** An autonomous SRE acting on prod is a trust surface (mitigated by default-gated writes, blast-radius + spend budgets, escalate-on-unknown, full audit), and on-call is lean — full ITSM is out of first-cut scope.

## ADR-0086
**Replay/live equivalence gate for deterministic materialization folds.**

### Context
Plan 11 and Plan 32 require the same materialization value whether a client sees updates live or the runtime rebuilds that materialization from the event log. ADR-0050 already says native materializations are reactive over the log, delivered as consistent snapshots, and rebuildable from zero. HOBO-60 turns that claim into a falsifiable gate before the Reactor, snapshot, and rebuild slices depend on it.

### Decision
1. **Replay/live equivalence is a reusable conformance primitive.** A materialization must pass a helper that folds a live event interleaving and a replayed event-log slice to the same normalized state.
2. **The comparison point is a per-stream `seq` vector, not a scalar global position.** Multi-stream materializations compare at `{ streamId -> seq }`, matching ADR-0050's per-stream consistency model.
3. **Folds and operators are pure, read-only, and seeded.** They may read only the current event, prior state, declared arguments, and the runtime-provided seeded clock/random/env context. Ambient `Date.now`, `Math.random`, process env, IO, `step`, and writes are outside the fold boundary and fail the gate.
4. **Cross-stream arrival order is not semantics unless it is canonicalized.** A fold that changes result based on live arrival order rather than the materialization's declared `seq` vector is invalid. Order-sensitive math must use exact/canonical accumulators; floating-point accumulation order drift is a gate failure.
5. **Upcasters are inside the proof.** Event-body upcasters run before the fold in both live and replay paths; they must be pure and total over the corpus HOBO-57 will maintain.

### Consequences
- **(+)** Reactor, snapshot, and rebuild work get a small, importable assertion that catches wall-clock reads, arrival-order dependence, floating-point drift, and impure upcasters before those bugs become data-plane invariants.
- **(+)** The proof is cheap enough to run as a contract test in downstream packages and precise enough to explain a mismatch with live/replay event order and state.
- **(-)** Authors must either keep multi-stream materializations order-insensitive or explicitly define a canonical order/accumulator; convenient but order-dependent folds are rejected.

## ADR-0089
**GraphQL facade generation boundary over materialization contracts.**

### Context
Plan 32 and ADR-0050 define the request/response query surface as a GraphQL facade over materialized
views and cached snapshots, while subscriptions map onto the same observable materializations. HOBO-65
spiked whether the SDL, query fields, subscription fields, and resolver stubs can be generated from
canonical WIT read-model records plus projection/materialization metadata without creating a second
read engine.

### Decision
1. **Generate SDL from canonical WIT read-model records.** WIT records and enums are the source for
   GraphQL object and enum types; field names are deterministically transformed from WIT names into
   GraphQL names and checked for collisions.
2. **Generate root fields from projection/materialization metadata.** Query fields are generated for
   materialization snapshot reads. Subscription fields are generated only when the materialization is
   reactive by ADR-0052's rule: native log-backed or backed by a change-feed-advertising sink.
3. **Generate thin dispatch, not resolver business logic.** Generated resolvers call the existing
   materialization read path; generated subscriptions attach to the same observable materialization
   the `subscribe`/`useSubscription` surface uses. The facade must not introduce its own store,
   planner, read-set tracker, or reactivity engine.
4. **Keep policy-heavy behavior outside pure generation.** Tenant scoping, `.allow()` checks,
   pagination/index constraints, search/vector/OLAP escape hatches, and raw-driver behavior remain
   generated hooks or hand-authored policy adapters around the projection boundary, not inferred
   solely from WIT records.
5. **Gate non-reactive honesty at generation time.** A non-reactive sink can expose query/snapshot
   fields, but GraphQL subscription generation is rejected rather than producing a static field that
   looks live.

### Consequences
- **(+)** The GraphQL facade stays a deterministic codegen view over the existing data-plane
  contracts, so query and stream keep one model and one engine.
- **(+)** The generated surface is reviewable and drift-gated alongside ADR-0037 codegen artifacts.
- **(-)** Advanced resolver behavior is intentionally not fully generated; custom policy,
  pagination, and search semantics still need explicit adapter hooks.

## ADR-0098
**Generation eval methodology: hybrid rubrics, golden trajectories, and independent calibration.**

### Context
Plan 23 defines live evals as the reward signal for `"use training"` semantic functions and AI-generated
implementations. HOBO-309 already pins the promotion gate shape: conformance stays the hard contract
gate, eval thresholds score quality/faithfulness/calibration/cost/latency, and policy decides whether
a passing candidate may promote. What remains open is the methodology behind those scores. A naive
single LLM judge can be gamed by the optimizer it trains, a purely programmatic rubric misses semantic
quality, and a golden-master sample alone can ossify bad behavior.

### Decision
1. **Use a hybrid evaluator, not a single judge.** Each semantic function declares dimensions with an
   evaluator kind: programmatic checks for deterministic invariants, golden-trajectory reproduction
   for recorded behavior, LLM judges for semantic quality, and human-label sampling for calibration.
   A promotion score is a composed result over those dimensions, never a raw LLM-judge score.
2. **Make the trajectory golden the stable primitive.** A `trajectoryGolden` is a signed, replayable
   scenario set: prompt/input, tool trace, expected facets, tolerance windows, forbidden outputs, and
   provenance. It is a Golden Suite target ([ADR-0082](02-identity-security.md#adr-0082)) for customer
   agents and generated implementations, and it runs in replay/fork lanes rather than live prod.
3. **Separate training, held-out, and adversarial lanes.** Candidate optimization may see training
   trajectories, but promotion requires held-out trajectories and adversarial counterexamples that
   are not available to the optimizer loop. The held-out/adversarial split is a hard eval term, not
   advisory metadata.
4. **Require independent calibration.** Any LLM-judge dimension that affects promotion must be
   backed by at least one independent check: another pinned judge family, a human-label sample, or a
   programmatic oracle for that dimension. The training judge cannot be the only promotion judge.
5. **Set minimum evidence floors.** Every rubric declares min-sample floors for shadow traffic,
   human-label sampling when used, and per-critical-dimension coverage. Underpowered runs conclude
   `inconclusive` and stay shadow; they cannot promote as a weak positive.
6. **Keep reward-hacking guards explicit.** The eval report records judge versions/prompts, held-out
   split identity, adversarial case pack, calibration drift, and failed dimensions. A candidate that
   improves the training judge while regressing held-out, adversarial, independent, or hard safety
   dimensions fails promotion even if its aggregate score rises.

### Consequences
- **(+)** The optimizer gets a useful, continuous reward without letting one judge become a new trust
  boundary. Golden trajectories make semantic behavior reproducible enough to review, replay, and
  re-bless through the existing Golden Suite/A2H path.
- **(+)** HOBO-309's promotion gate stays intact: this ADR decides how eval facts are produced and
  calibrated, not whether conformance or policy can be bypassed.
- **(-)** Hybrid evals cost more than one judge call and require curation of held-out/adversarial
  packs. Thin semantic functions can start with smaller suites, but their coverage report must state
  that limitation honestly.

## ADR-0099
**Data-flywheel privacy model for trajectory capture and training.**

### Context
Plan 23 and ADR-0025 make OpenInference trajectories the training-data unit for
`"use training"` methods. HOBO-335 pinned the capture contract, but HOBO-364
needed the privacy recommendation before capture scales: trajectories can carry
PII, secrets, tenant-private prompt context, and tool payloads that must not leak
across tenants or be re-emitted through trained methods.

### Decision
1. **Classify before persistence.** Runtime capture classifies every trajectory
   payload field as `public`, `internal`, `pii`, or `secret` before it enters the
   trajectory store. Public fields may be stored as cleartext; internal fields
   are minimized to hashes unless policy explicitly keeps them; PII is stored as
   token references plus per-run encrypted references; secrets are sealed as
   encrypted references only.
2. **Raw sensitive access is in-boundary and policy-gated.** External optimizer
   or judge adapters, including Agent Lightning and Trace providers behind the
   `training-engine` port, never receive decrypted PII or secrets. If an
   in-boundary optimizer genuinely needs raw PII for an approved purpose, it
   must request policy-gated decryption scoped to the same tenant, run, class,
   purpose, and approval. Secret raw access remains deny-by-default.
3. **Tenant isolation is fail-closed.** A trajectory can be written only to a
   store partition whose tenant matches the run tenant, and a training consumer
   can read only same-tenant trajectory partitions unless a future explicit
   aggregation contract says otherwise. Cross-tenant mismatch suppresses capture
   and emits an audit event instead of partially storing data.
4. **Retention, sampling, and opt-out inherit the trace policy.** Trajectories
   are captured only for sampled traces, and effective retention is the strictest
   positive limit among trace retention, requested trajectory retention, the
   tenant maximum, and the platform default. Tenant, method, user, and field
   opt-outs suppress capture or omit fields before storage.
5. **Optimizer payloads are redacted artifacts.** The training input given to an
   optimizer is reconstructed from transformed fields, never from raw captured
   values. Tokenized PII may be used as a stable placeholder; secrets are
   omitted. Prompt/code candidates must pass the existing eval/conformance gate
   for forbidden PII/secret output, so the privacy model and promotion gate
   defend against PII-in-prompt re-emission together.

### Consequences
- **(+)** Trajectory capture can proceed without creating a new trust path:
  redaction happens before persistence, external trainer providers stay behind
  redacted boundaries, and tenant isolation fails closed.
- **(+)** The privacy contract is executable in
  `src/draft/exp-proofs/dx/data-flywheel-privacy-spike`, including cross-tenant leakage and
  PII re-emission adversarial cases.
- **(-)** Tokenized/redacted trajectories can reduce optimizer quality for tasks
  that depend on exact raw text. Those tasks need explicit in-boundary approval
  or accept the quality tradeoff.

## ADR-0100
**generateProvider correctness is a deterministic certification property.**

### Context
Plan 23 defines the generate -> validate -> repair -> certify loop for generated providers, and
Plan 09 makes conformance plus trace replay the verification boundary. HOBO-211 spiked whether that
claim can be made falsifiable for a reference database provider without building the production
`generateProvider` loop.

*Naming note: `hobo:database/postgres@0.1.0` is the frozen reference-proof port id; the canonical catalog name is `hobo:data/relational` ([ADR-0112](#adr-0112)).*

### Decision
1. **Correctness is a reference event-stream proof, not a prose claim.** A provider generation run
   starts from `gen.Requested` with authoritative WIT, conformance suite, Capability Manifest,
   sanitized material refs, pinned model, frozen prompt, and seed. The run may certify only after
   no-egress validation, provider conformance, trace replay, coverage, and provenance gates pass.
2. **The canonical reference target is the database provider.** The acceptance harness must prove a
   `hobo:database/postgres@0.1.0` provider can converge, replay recorded database traces, pass the
   local database conformance suite, and produce a reference `gen.Certified`/`gen.PluginCertified`
   record tied to the actual validation report.
3. **Repair is bounded and fail-closed.** The default automated repair budget is two repair attempts.
   A candidate that keeps failing validation emits `gen.NeedsHuman` with `repair-budget-exhausted`;
   it is not silently retried, broadened, or certified.
4. **Reproducibility requires pinned inputs.** The artifact digest and certification payload are
   reproducible only when the target WIT, suite, Capability Manifest digest, model digest, frozen
   prompt digest, seed, material refs, and policy input hash are pinned. Hosted aliases or
   temperature-driven nondeterminism can be re-verified, but cannot make a bit-reproduction claim.
5. **Minimum production coverage must include local and real Camp behavior.** A database provider
   must pass the required local lifecycle checks and real-provider Camp behavior checks. A reference,
   thin, local-only, or fixture-Camp suite is not enough for production certification even if every
   check it contains passes. Untrusted cold-start docs are hints only and cannot override the
   authoritative target WIT or suite.

### Consequences
- **(+)** Plan 23 provider-generation correctness now has an executable, reviewable reference proof
  in `src/draft/technical-proofs/generateprovider-correctness-spike`.
- **(+)** HOBO-307, HOBO-320, HOBO-327, HOBO-330, HOBO-346, and HOBO-102 remain the production
  building blocks; this ADR only fixes their acceptance boundary.
- **(-)** The production loop still needs to wire these gates together and obtain real Camp evidence;
  this spike deliberately does not implement provider runtime defense or training optimizer internals.

## ADR-0112
**`hobo:data` is the canonical WIT port of the `data()` resource; `wasi:sql` is driver-level; the never-defined SQL WIT port is retired; `hobo:database/*` is a frozen proof alias.**

### Context
The resource→WIT-port spine for the data block has three divergent spellings. [Plan 21](../authoring-resources-wiring.md#plan-21) maps `data()` → `hobo:data` (catalog rows + manifest-IR example). [Plan 20](../wasm-runtime-wit.md#plan-20)'s self-described canonical port catalog instead lists a superseded `sql` resource over `wasi:sql` (plus a never-defined HoBo SQL extension) and never defines `hobo:data`. [ADR-0100](#adr-0100) and the HOBO-211 generation proofs target `hobo:database/postgres@0.1.0`. [ADR-0052](#adr-0052)'s "`data`, not `sql`" decision is settled semantics; this ADR gives that decision one naming spine.

### Decision
1. **`hobo:data` is the canonical app-facing WIT port** the `data()` resource links against, with paradigm sub-interfaces `hobo:data/relational · hobo:data/document · hobo:data/graph · hobo:data/vector · hobo:data/key-value` (exactly the [ADR-0052](#adr-0052) paradigm taxonomy; the key-value *paradigm* sub-port is distinct from the `kv()` resource over `wasi:keyvalue`). Key functions map 1:1 to the `.allow()` verbs: `read(key/query)`, `write(record)`, `query(predicate)` (the predicate DSL shared with `hobo:projection`/`hobo:search`, [Plan 32](../data-plane.md#plan-32)), `admin(migration-plan ops)`.
2. **Port relationships stated once:** `hobo:projection` stays the projection/fold port and `hobo:search` the query-extension port ([ADR-0034](#adr-0034)); `hobo:data` is the resource-level port a `data()` link resolves to, and a paradigm sub-interface is what a provider exports.
3. **There is no `sql` resource.** `wasi:sql` is demoted to a driver-level reused interface that a `hobo:data/relational` provider/sink driver MAY realize its mapping over (consistent with [Plan 32](../data-plane.md#plan-32) §Projection events & ports).
4. **The never-defined SQL WIT port is retired**; the relational idiom layer is the `@hobo/sql` npm package ([ADR-0081](#adr-0081)), which lowers through `hobo:data` — package name unchanged.
5. **`hobo:database/postgres@0.1.0` is the frozen provider-target id** used by [ADR-0100](#adr-0100) and the HOBO-211/HOBO-324 reference proofs/fixtures; it names a Postgres provider of `hobo:data/relational`. Proof code under `src/draft` is NOT rewritten; new docs must use `hobo:data/relational`.
6. **Plan 20's interface catalog is the single authoritative registry** of port names; any resource→port row elsewhere must link a port defined there.

| Layer | Name |
|---|---|
| Resource | `data()` |
| Canonical port | `hobo:data` |
| Sub-interfaces | `relational · document · graph · vector · key-value` |
| Underlying reused WASI (relational drivers) | `wasi:sql` |
| Legacy aliases (do not use in new docs) | `sql` resource · retired SQL port · `hobo:database/*` |

### Consequences
- **(+)** The resource→WIT-port spine for the data block is defined at one authoritative row and all four names reconcile.
- **(-)** The frozen `hobo:database/*` alias survives in historical proofs/fixtures and must be read through the naming map.

## ADR-0117
**FinOps operator (the Crew's cost specialist): advisory-only ownership of the FinX outputs and commitment optimization.**

### Context
HoBo has the FinOps substrate — MeteringView/showback ([ADR-0039](02-identity-security.md#adr-0039)), CreditLedgerView/Dispatcher ([ADR-0071](01-architecture-core.md#adr-0071)), spend circuit-breaker + `costAvailabilityProfile` ([Plan 5](../reliability-observability-cost.md#plan-05)), and the FinX surface ([FinOps Budget Routing Control Plane](../finops-budget-routing-control-plane.md)) — but the ADR-0054 Crew roster names no cost operator. The FinX advisory outputs (forecasts, anomaly signals, commitments, optimization recommendations) and the "Commitment optimization" advisory in [Plan 5](../reliability-observability-cost.md#plan-05) have no named owner — a hole at the intersection of the FinOps and agent-native pillars.

### Decision
1. **Add FinOps to the ADR-0054 roster** on the unchanged shared model ([Plan 40](../operators-sre.md#plan-40)): SVID principal, per-agent policy + spend caps, engine behind a `finops-engine` port with a built-in default, sandboxed under [ADR-0061](02-identity-security.md#adr-0061) governance.
2. **FinOps owns** forecasts, anomaly signals, commitment/savings-plan recommendations, and optimization proposals — the FinX surface outputs and the [Plan 5](../reliability-observability-cost.md#plan-05) "Commitment optimization" advisory.
3. **Advisory-only and off-path:** reads MeteringView/CreditLedgerView/DecisionGraph projections autonomously; every write is a gated Delta/PR or require-approval obligation ([Plan 29](../contracts-policy-flags.md#plan-29)); it never auto-purchases commitments and never sits on the deterministic Matching/Dispatcher path — the AI/advisory layer stays off-path per [ADR-0071](01-architecture-core.md#adr-0071) point 3, and [ADR-0033](01-architecture-core.md#adr-0033) determinism is preserved.
4. **Boundaries:** SRE keeps `spend.DegradationRequired` enforcement; Endpoint Monitor keeps signal emission; Platform Engineer keeps Resource Definitions; FinOps escalates via `crew.HandoffRequested`; **no new event families** (rides `crew.*`/`spend.*`/`policy.Decided`).

### Consequences
- **(+)** Every FinX advisory output has a named, audited, policy-gated owner at the intersection of FinOps and agent-native pillars.
- **(−)** One more trust surface in the roster; recommendation quality is bounded by best-effort credit/usage reconciliation ([ADR-0071](01-architecture-core.md#adr-0071) point 6).

## ADR-0118
**App-facing `cache(name)` is a first-class catalog port (`hobo:cache`), distinct from the durable `kv` store: ephemeral, TTL-first, evictable, and never a source of truth.**

### Context
The resource catalog ([Plan 21](../authoring-resources-wiring.md#plan-21)) folds caching into `kv`/`data` (the catalog note reads "data/caching (`data`/`kv`)"), but `kv` is a **durable** key-value store — its equivalence class is DynamoDB/Cosmos/Firestore/CF-KV, stores that are a source of truth with no TTL or eviction contract. Every mainstream PaaS in the 2026-07-03 competitor expansion exposes an **ephemeral cache** as a separate primitive — Encore's `cache` (ElastiCache/Memorystore), Vercel KV / Upstash Redis, Railway and Render "Key Value (Redis)", Fly's Upstash — because a cache carries semantics a durable store does not: a bounded TTL, eviction under memory pressure (LRU/LFU), and "never the source of truth." Folding cache into `kv` is therefore both a **catalog gap** (no TTL/eviction surface an app can declare) and a latent **parity overclaim** — the same defect class the register keeps catching (GAP-025 dapr, DRIFT-006 nitric): a HoBo app that needs a cache-aside layer has no honest port to name. CDN/edge caching is already covered by `web()` and is out of scope here; this ADR is about **application-level** caching.

### Decision
1. **New catalog resource `cache(name)`** → **`hobo:cache`** WIT port, separate from `kv(name)`/`wasi:keyvalue`. `.allow()` verbs: `get`, `set`, `delete`, `invalidate` (admin `flush` is a distinct grant). Equivalence class (owned by [Plan 4](../control-plane.md#plan-04)): Redis/Valkey (self-host floor) · ElastiCache/MemoryDB · Azure Cache for Redis · Momento · Memorystore · Cloudflare Cache API.
2. **Semantics that make it a cache, not a store:** every entry carries a TTL (required or defaulted); the provider MAY evict before TTL under pressure (documented policy, default LRU); reads return `value | miss` (a cold key is never an error); **the cache is never a source of truth** — a cold or evicted cache degrades to recompute-from-source, so correctness never depends on a hit. Surface: `set(key, value, { ttl, tags? })`, `get(key)`, `delete(key)`, `invalidate({ tag })`.
3. **Event-sourced invalidation (opt-in), no new machinery:** tag-scoped invalidation can subscribe to the event log so a `data` write invalidates its tags — the reactor ([ADR-0050](#adr-0050)) already carries the change stream, so this adds **no new event family** (it rides `data.*`/projection events). Cache-aside is the default; write-through invalidation is opt-in.
4. **`kv` is re-scoped to durable-only.** The `authoring-resources-wiring.md` catalog note "data/caching (`data`/`kv`)" is corrected: `kv` / `data.key-value` is the **durable** store (source of truth, no eviction contract); `cache` is the **ephemeral** layer. Escape hatch: `.with()` for provider-native tuning (maxmemory-policy, cluster mode).
5. **Secretless and governed like every port:** the connection is a brokered reference, not a value (secretless-first, as with `secret`/`crypto` — [ADR-0113](02-identity-security.md#adr-0113)); deny-by-default falls out of linking; cost/QoS flow through metering and `costAvailabilityProfile` ([ADR-0039](02-identity-security.md#adr-0039)) — a cache is a natural graceful-degradation lever.

### Consequences
- **(+)** Closes the one genuine catalog gap the 2026-07-03 infra re-classification found, and removes a latent parity overclaim — apps declare a cache honestly, with TTL/eviction semantics a durable `kv` never promised.
- **(+)** The new competitor captures (Encore/Vercel/Railway/Render/Fly/Modal) map to a real `hobo:cache` row instead of an over-broad `kv` ✅.
- **(−)** One more port and equivalence class to conformance-gate; the `kv`-vs-`cache` distinction has to be taught (mitigated by the "never a source of truth" one-liner).

## ADR-0119
**Realtime collaboration (presence / awareness / multiplayer) composes from existing primitives — `websocket()` rooms + the reactor + the ephemeral `cache` port, with CRDT state-merge as the opt-in topology; a first-class `presence` capability stays an opt-in package, not a v1 core primitive.**

### Context
The 2026-07-03 infra re-classification flagged "realtime collaboration" as backlogged. The substrate already exists — `websocket(name)` with rooms/broadcast ([ADR-0075](07-portability-extensibility.md#adr-0075)), the reactive reactor with live `useQuery()` + consistent snapshots ([ADR-0050](#adr-0050)), and the cross-Camp `active-active-eventual` CRDT state topology ([ADR-0040](01-architecture-core.md#adr-0040)) — but there is no app-facing **presence/awareness** primitive (who's online, cursors, typing indicators, live selection) that a collaborative app (Figma/Notion-style) reaches for. Convex/Lakebed and the realtime-BaaS set make presence a first-class expectation. The open question is whether HoBo needs a dedicated `presence` primitive or whether presence composes from what already exists.

### Decision
1. **Presence composes from existing ports; no new core primitive in v1.** Awareness/presence is ephemeral per-connection state broadcast to a room: `websocket()` rooms carry the connection/broadcast channel ([ADR-0075](07-portability-extensibility.md#adr-0075)), the reactor fans out derived live views ([ADR-0050](#adr-0050)), and the new ephemeral **`cache` port** ([ADR-0118](#adr-0118)) is the natural store for TTL'd presence state — a presence entry is exactly "ephemeral, evictable, never a source of truth," so it self-heals when a client drops and its TTL lapses.
2. **Shared-document co-editing uses the declared replication topology.** Multiplayer *state merge* is the `active-active-eventual` CRDT topology already designed ([ADR-0040](01-architecture-core.md#adr-0040)); presence (awareness) is explicitly the *ephemeral* layer above it and needs no durability.
3. **A `@hobo/presence` convenience is an opt-in package (future iteration hook), not a catalog port.** If demand warrants, a thin package wires rooms + cache + reactor into a `usePresence()` ergonomic — the same opt-in-package pattern as `@hobo/vector`/`@hobo/graph` ([ADR-0081](#adr-0081)) — adding no new runtime and no new event family.
4. **Non-goal:** a bespoke presence server or a proprietary awareness protocol. HoBo does not re-implement Yjs/Liveblocks; it exposes the primitives they build on and can adopt such an engine behind a package.

### Consequences
- **(+)** Records the realtime-collaboration decision (closing the re-classification item) without speculative surface — presence is buildable today from rooms + reactor + cache, and the `cache` port (ADR-0118) turns out to be the missing piece.
- **(+)** Keeps the catalog lean; presence ergonomics arrive as an opt-in package if demand appears, not as premature core.
- **(−)** A collaborative-app author composes three primitives (or reaches for the future package) rather than one turnkey `presence()` — a documented convenience gap, not a capability gap.

## ADR-0125
**Trainable-annotation surface v1: signature-only empty implementations, param/output metadata on the contract, optional decorator sugar — and an ax-backed built-in `training-engine`.**

### Context
[ADR-0025](#adr-0025) fixed the trainable-method model (`"use training"` directive + `training(fn, opts)` wrapper, optimizer behind a `training-engine` WIT port) and [Plan 23](../generated-stack.md#plan-23) fixed the pipeline (trajectories → live-evals → candidate → gated promotion). Three edges were left unresolved as the first implementation slice lands in `packages/`:
1. **Empty/initial implementations.** The design says a stub is "the natural baseline of a `"use training"` method," but the authoring surface had no form for declaring a trainable method with **no body at all** — signature + grounding only, implementation synthesized by the engine (the [ADR-0010](#adr-0010) cold-start path).
2. **Param/output-level annotations.** Grounding was method-level (intent + contract + rubric); there was no idiomatic way to attach trainable metadata to individual parameters and outputs.
3. **The built-in engine was named ("an OPTO/prompt-rewrite optimizer") but unsourced.** A survey of the mid-2026 landscape found exactly one mature TypeScript-native, DSPy-style optimize-and-persist framework: [ax (`@ax-llm/ax`)](https://github.com/ax-llm/ax) (Apache-2.0) — typed signatures, GEPA + bootstrap-few-shot `optimize()`, and a serialized-optimized-program JSON artifact with runtime `applyOptimization()`. Microsoft Trace and Agent Lightning remain Python-only — pattern donors, exactly as ADR-0025 already treats them. No successful TS AI framework uses class decorators as its primary surface (decorators cannot type free functions or carry inferred param/output types); typed wrappers/builders win, with TC39 stage-3 decorators + `Symbol.metadata` viable as class-method sugar.

### Decision
1. **Four equivalent authoring forms, one lowering.** All forms lower to the **same** `hobo:sdk` WIT calls + manifest facts and add no new semantics ([ADR-0072](01-architecture-core.md#adr-0072) thin-idiom rule):
   - `"use training"` **directive** — canonical, unchanged.
   - `training(fn, opts)` **wrapper** — unchanged semantics; `opts` gains optional `params` / `output` metadata (point 2).
   - **`training.define(opts)` — signature-only, the empty-implementation form.** No body: the callable is immediately servable, backed by a **contract-derived stub baseline** ([ADR-0076](02-identity-security.md#adr-0076) `mock` mode — typed responses derived from the contract, calls recorded as specification-by-example) until the engine synthesizes and promotes an initial implementation through the ADR-0010 cold-start path. `training(stub(), opts)` remains the explicit-stub spelling; `define` is its signature-first sugar.
   - **`@trainable(opts)` class-method decorator — optional sugar only.** TC39 stage-3 + `Symbol.metadata` (never `experimentalDecorators`), defined as compiling to the wrapper form with byte-identical manifest facts (an equivalence asserted by the runtime package's tests; a conformance suite registration remains open). It exists for OO-styled codebases; the wrapper/directive stay canonical because decorators cannot annotate free functions.
2. **Param/output trainable metadata rides the contract, not a new channel.** Per-parameter and per-output descriptions, examples, and constraints attach via the contract schema (Standard-Schema/Zod `.describe()` and `opts.params` / `opts.output` entries) and lower to manifest facts + CUE constraints — parse-don't-validate is preserved, and the Four-lens gate (Contract/Eval/Policy/Trace) governs unchanged. The optimizer consumes this metadata as signature-field descriptions; it never gains a side channel around the contract.
3. **The built-in `training-engine` is implemented on ax, invisibly.** The default engine behind the port maps `{ intent, contract }` → an ax signature, `rubric` → an ax metric, trajectories → examples, and runs ax `optimize()` (GEPA + bootstrap few-shot). ADR-0025 point 3 is unchanged: the engine is **never part of the SDK surface**; swapping it (built-in ax → Agent Lightning → Trace → future) is a config change. Single-maintainer risk on ax is bounded by the port: pinned version, platform-owned interface, replaceable without app-code changes.
4. **The training artifact is a first-class, provenance-pinned record.** An optimization run yields a **serialized optimized program** (instructions + demos as JSON, engine-id + version + eval-report pinned). **Apply-at-load is the low-risk promotion mode**: the artifact ships beside the component and is applied at instantiation — no source mutation, trivially reversible (drop the artifact). AST region-scoped **code** mutation ([ADR-0048](#adr-0048)) remains the high-touch mode for candidates that rewrite the body. Both modes pass the identical promotion gate (conformance + eval thresholds incl. held-out/adversarial split + policy); artifact promotion emits the same `training.*`/`impl.*` events.
5. **Reward capture reuses existing infra; OTel GenAI is an export mapping, not a fork.** Trajectories remain OpenInference-on-OTel riding the event log ([ADR-0025](#adr-0025) point 4, [ADR-0099](#adr-0099) privacy unchanged). The OpenTelemetry **GenAI semantic conventions** (still experimental) are supported as an additional boundary export mapping with the semconv version pinned — no parallel telemetry path, no new event families (`training.*`, `eval.*`, `impl.*` cover the loop).

### Consequences
- **(+)** Developers get idiomatic trainable annotations at every granularity — method (directive/wrapper/decorator), parameter, and output — plus a true empty-implementation form: declare intent + contract + rubric, run immediately on a stub, let the engine grow the implementation. The promised `import { training } from "@hobo/runtime"` becomes real code.
- **(+)** The built-in engine stops being aspirational: ax provides typed signatures, a production-grade optimizer, and an artifact format that matches HoBo's offline-train → gated-promote → runtime-load shape, at zero SDK-surface cost.
- **(−)** Four authoring forms must be kept provably equivalent (a conformance lane, not a convention); the decorator form is a second surface to document and lint.
- **(−)** A pinned third-party optimizer inside the built-in engine adds a supply-chain dependency to track (mitigated by the port boundary and the engines-behind-ports rule).

## ADR-0137
**Session Replay is a default-supplied, privacy-first Station capability (`@hobo/replay`), distinct from control-plane event-log replay.**

### Context
Operators and coding agents need OpenReplay-class session reconstruction for web Bindles and local Stations: DOM mutations, network/console/errors, correlation to control-plane incidents, Trails, and Harness flag exposures. The monorepo already has a **replayable control-plane event log** (projections, SRE, audit) and auth `session.*` events — overloaded "replay"/"session" language risks conflation. Competitors (OpenReplay AGPL stack, PostHog, Sentry, Highlight) show that privacy-by-default masking, low-footprint async trackers, self-host data ownership, and error/session correlation matter. HoBo must deliver the experience **natively** (Stations, dual fixtures, secretless, Junction storage ports, Trails retention, OpenFeature progressive control, MCP/CLI parity) without making AGPL multi-service K8s the default path.

### Decision
1. **Package `@hobo/replay` owns Session Replay.** Tracker, privacy masks, SessionBlobStore/SessionIndex ports, dual-fixture adapters, player/OpenUI descriptors, access policy, retention recipes, metering hooks, and template auto-wire. No new control-plane noun; composition over Station / Junction / Trail / Harness / continuous identity / PAM.
2. **rrweb is the capture/reconstruction primitive.** Injectable `RecordEngine` / `ReplayEngine` adapters; default CI path uses deterministic fixtures. OpenReplay is inspiration + optional full-suite Station template (Assist/cobrowsing), **not** a default dependency.
3. **Event family is `replay.*`, not `session.*`.** Lifecycle: `replay.Started`, `replay.ChunkIngested`, `replay.Ended`, `replay.ErrorLinked`, `replay.RetentionApplied`, `replay.Accessed`, `replay.Disabled`, `replay.Metered`. Heavy rrweb streams never enter the control-plane event log — only content-addressed `blob_ref`s. Auth keeps `session.Started|Refreshed|Revoked`.
4. **Default-supply rules.** Local / Station / dual-fixture / every **App Kit** (api, web, service, ui, websocket, job, wasm-component): **on** by default with zero Bindle config. Production/staging: **off** unless OpenFeature flag `hobo.session-replay` or explicit sample rate. Kill switch: `HOBO_REPLAY=0`.
5. **Privacy by construction.** Client-side mask of password/email/tel inputs and configurable selectors before send or local persist; network header redaction; continuous-identity `principalRef` attribution without free-text PII; production view requires elevated PAM capability.
6. **Station isolation fails closed.** Cross-Station or cross-isolation-class viewing requires federation grant (Junction) or elevated short-lived capability; audited.
7. **Trails compose retention.** Platform recipe id `replay.retention` for GC/erasure; FinOps meters ingest bytes, storage, and player access.
8. **CLI/MCP:** `hobo replay` (list|get|open|summarize|retention|doctor) with MCP tool parity via CANONICAL_VERBS. Control Yard / OpenUI player is read-only; CLI remains the mutation surface.
9. **Evidence:** session recordings may ship in evidence packs alongside Playwright/CDP artifacts for behavior proofs.
10. **Deep Bindle integration (App Kits):** every **App Kit** (`api`, `web`, `service`, `ui`, `websocket`, `job`, `wasm-component`) receives a default `session-replay` platform annotation at construction — not only Web Kits. Prefer the term **App Kit** / **Kit** over calling these "membrane types" at the Bindle authoring layer (the WIT/WASM membrane remains the low-level portability contract per ADR-0069). Local Yard / `hobo dev` wraps every HTTP App Kit entrypoint so HTML injects the privacy-first bootstrap and `/__hobo/replay/*` serves ingest/list without app-author wiring. Opt out with `.with(sessionReplay({ enabled: false }))` or `HOBO_REPLAY=0`.

### Performance budget
- Batch interval 1000 ms, batch size 50, main-thread per flush ≤ 16 ms target, tracker overhead beyond rrweb ≤ ~15 KB gzipped.

### Honest Scope / residual
- Live multi-cloud object storage + high-volume ClickHouse analytics: port-shaped / residual — dual fixtures are the default proof path.
- Full OpenReplay Assist / Helm deploy: optional Station template, not required for success.
- Scale soak of production ingest and long-term retention cost models: residual hardening.

### Consequences
- **(+)** Agents and humans get a first-class session evidence surface that dogfoods Stations, privacy defaults, and progressive delivery without a second event bus or secret store.
- **(+)** Naming split (`replay.*` vs event-log "replay" vs auth `session.*`) prevents contract and doc collisions.
- **(−)** Three "replay/session" concepts must stay documented in glossary and CLI help; authors must not emit full DOM streams into the control-plane log.
## ADR-0139
**HoBo Code: coding harness and harness multiplexer (`hobo-code` / `@hobo/code`).**

### Context
Agents and humans need an opinionated path to write complete HoBo apps/Bindles end-to-end with extreme templates + ts-autocode, while protecting the canonical project tree. Existing surfaces already cover pieces — `hobo codegen` (HOBO-152), hobo-code-dsl (HOBO-394), `hobo sandbox`, stations (ADR-0131), trails (ADR-0134), OpenFeature/Harness (ADR-0044/0083), FinOps, SWE connectors, connectivity named endpoints (ADR-0130) — but there was no elevated **coding harness + multiplexer** that composes them under one product CLI with isolation purity, evidence triples, and durable learning outside ephemeral sandboxes.

External foundations inform the design (rift CoW isolation, Flue/Pi harness base, Herdr multiplexer UX, Grok Build visual patterns, OpenUI lock-in, Playwright evidence, Vercel Worlds durability, mozilla-ai/cq; distributed-hive shape inspired by [block/buzz](https://github.com/block/buzz)) without vendoring those tools into the monorepo and **without** introducing a user-facing `buzz` verb.

### Decision

#### Open questions resolved

1. **Package / CLI surface.** Standalone binary **`hobo-code`** (dash permitted; package `@hobo/code` declares the bin). **Not** a `hobo <verb>` and **not** nested under `buzz`. Flat verbs with **`dispatch` as the default** (`hobo-code <prompt…>` ≡ `hobo-code dispatch <prompt…>`). MCP/harness tools remain available from the harness core. Rationale: coding harness is a product surface, not another lifecycle verb on the canonical `hobo` CLI.

2. **Mediated project access.** Pure agent-codegen / agent mode is **always mediated** (rift or worktree + fixtures + templates). Interactive human authoring outside agent mode retains normal project writes. Agents (and the user while in pure codegen mode) never receive unrestricted write access to the canonical tree. **Promotion is the sole audited mutation path** and is gated (`architecture:guard`, `standards:check`, scoped `agent:check`, `docs:freshness`, plus `promotions:check` when elevating drafts).

3. **Primary local durability backend.** **Local World** under `HOBO_HOME/worlds/<runId>` (outside ephemeral isolation). Composes cleanly with Station occupancy: long-running privileged sessions pin `stationId` + rail context; durable checkpoints survive rift/worktree cleanup. Vercel Worlds / Workflow SDK remain the production adapter shape (ADR-0123); Local World is the offline/dev default.

4. **Rift vs worktree aggressiveness.** **Rift preferred when CoW probe succeeds** (`HOBO_RIFT=1` + platform CoW); **git worktree is first-class fallback** and the **CI default**. Windows and non-CoW filesystems always use worktrees. Platform matrix is executable in `@hobo/code` (`ISOLATION_PLATFORM_MATRIX`). Rift is never vendored into the repo.

5. **Monetization default.** Product default **ON** via OpenFeature `code.monetization.surface`. Disable deliberately with `HOBO_CODE_MONETIZATION=0` or `hobo feature set code.monetization.surface --percent 0`. Sponsored wait/status surfaces never inspect prompts or code. FinOps policy owns spend caps and provider routing; monetization cannot override budget gates.

6. **Relationship to the canonical `hobo` CLI / cli-spec.** Coding harness is **not** a `hobo` verb. The harness adds no canonical `hobo` verb (`CANONICAL_VERBS` is pinned by the cli-docs gate); `hobo-code` is a separate binary documented in cli-spec under its own section. It does not replace `codegen`, `sandbox`, `new`, `stub`, or `generate` — it elevates and orchestrates them for agent harness workflows.

#### Architecture decisions

1. Package `@hobo/code` owns isolation, harness core (Flue-style composition boundaries), scaffolding, evidence, visual lock-in, TUI status, FinOps budget hooks, remote registration, distributed hive, and dogfood helpers.
2. Isolation root: `HOBO_HOME/sandboxes/<runId>`. Durable learning: `HOBO_HOME/durable/code/<runId>` + `HOBO_HOME/worlds/`. Cleanup never erases durable learning.
3. Exclusive **squash-merge** only for agent contributions.
4. High-value template `openui-astryx-bindle` ships Gherkin linked to OpenFeature; passing scenarios emit the evidence triple (Playwright script + mp4 + screenshots).
5. Token/context tools (caveman, ponytail, RTK, tgrep, mgrep, headroom, serena) remain global/MCP — never vendored into project workspace.
6. Continuous improvement of templates/autocode is expressible as Trails (`code.templates.improve`, `code.autocode.heuristics`); cq `/cq:reflect` is the session-end knowledge hook.
7. Herdr-like status surface is the primary UX; Grok Build supplies visual/clickable patterns by reference (no full Rust port inside the TS monorepo).
8. Remote: deterministic named endpoint via ADR-0130 (`code` resource). mosh is documented exploratory resilience, not a hard dependency.
9. Distributed hive verbs are **flat** on `hobo-code` (`dispatch`, `join`, `agent`, `nodes`, `rooms`) — never nested under a `buzz` subcommand. OpenFeature key is `code.distributed` (default ON).

### Consequences
- **(+)** One dogfooding harness that consumes stations, trails, OpenFeature/Harness, FinOps, connectivity, and training/cq without parallel control planes.
- **(+)** Sandbox purity and cleanup guarantees are unit-tested; promotion fails closed without gates.
- **(+)** Elevates HOBO-152 / HOBO-394 rather than forking a second codegen stack.
- **(+)** Product CLI is unambiguous: `hobo-code` binary, flat verbs, `dispatch` default — no buzz nesting.
- **(−)** Real Rhai WASM, live Playwright video encoding, and Herdr PTY multiplexer polish remain residual productization — Local World + Rhai-subset + evidence structure close the one-shot gates. (Flue/Pi are real dependencies as of the Pi/Flue harness amendment: `@flue/runtime` powers the durable/programmatic agent in `packages/code/agents/hobo-code.ts`; `@mariozechner/pi-coding-agent` is the persistent interactive chat terminal, customized by `packages/code/pi/extensions/hobo.ts` with shared instructions/tools in `src/harness-customization.ts` / `src/harness-tools.ts`.)
- **(−)** Rift remains experimental; CI always exercises the worktree path.

### Amendment (defaults + distributed hive)

1. **All progressive OpenFeature flags under `code.` default ON** — `code.harness.enabled`, `code.evidence.visual`, `code.monetization.surface`, `code.isolation.rift`, `code.distributed`. Disable deliberately via OpenFeature / env (`HOBO_CODE_MONETIZATION=0` for monetization surface). Monetization remains privacy-first (never inspects prompts or code).
2. **CLI binary is `hobo-code`** (not a `hobo code` / nested `buzz` verb). Flat verbs with **`dispatch` as the default**. Distributed compute is a core shipped surface (internal hive module inspired by [block/buzz](https://github.com/block/buzz)): rooms, first-class agent identities, multi-node dispatch (local-process, worktree, rift, named-endpoint, MxC, OpenShell). OpenFeature key `code.distributed` (default ON). Not a vendored fork of Buzz; **not** a user-facing verb name.

### Amendment (Eve subagents · DeepAgents+OpenShell+MxC · Workflow Worlds)

hobo-code pins three external foundations as **composition contracts** (not vendored monorepo deps):

1. **Subagent definition = Vercel Eve shape.** Agents are filesystem-first directories (`agent.ts`, `instructions.md`, `tools/`, `skills/`, nested `subagents/`). The parent delegates to subagents the same way it calls tools; children start with a clean context and only the tools granted. In-repo contract: `@hobo/code` `defineEveAgent` / `defineEveSubagent` / `defaultHoboCodeEveAgents` (`packages/code/src/eve.ts`). Inspiration: [vercel/eve](https://github.com/vercel/eve) · [vercel.com/eve](https://vercel.com/eve). Eve runtime remains an optional production adapter; the **directory contract** is normative for hobo-code specialists (investigator / implementer / reviewer).

2. **Secure sandboxing = DeepAgents + OpenShell + MxC (as a stack).**  
   - **DeepAgents** orchestrates long-horizon coding agents (plan, tools, subagent spawn).  
   - **OpenShell** is the kernel-enforced secure runtime (deny-by-default network, policy-governed FS, credentials outside the sandbox).  
   - **MxC** is the stronger process/micro-VM isolation class for high-risk work (e.g. independent review of untrusted diffs).  
   Offline/CI still use mediated worktree/rift; production secure path prefers DeepAgents-orchestrated work inside OpenShell, with MxC when the Eve `sandboxClass` demands it. In-repo contract: `describeSecureSandboxStack` / `planSecureSandbox` (`packages/code/src/sandbox-stack.ts`). Hive node classes `openshell` and `mxc` stay first-class on the distributed matrix.

3. **Portable durable agent runtimes = Vercel Workflows + Worlds.** Durable steps, retries, and resume-after-restart ride the Workflow model; **Worlds** adapt event log + compute + queue (Local World offline under `HOBO_HOME/worlds/<runId>`; Vercel World for managed production). Aligns with ADR-0123 (workflow/step wrappers) and ADR-0135 Local World default. In-repo contract: `describeCodeWorlds` / `localWorld` / `vercelWorkflowWorld` / `planDurableWorkflowRun` (`packages/code/src/worlds.ts`). Harness `checkpoint`/`restore` remain Local World; production adapter shape is Vercel Workflow World.

**Non-goals of this amendment:** vendoring Eve, LangChain Deep Agents, OpenShell, or the Workflow SDK into the monorepo; inventing a parallel subagent CLI verb; weakening mediated-only isolation or promotion gates.

### Amendment (AI SDK HarnessAgent adapters)

Programmatic coding-agent turns go through Vercel AI SDK `HarnessAgent` ([Harness adapters](https://ai-sdk.dev/v7/docs/ai-sdk-harnesses/harness-adapters)). Dispatch is on the plugin's `runtime.adapter` (closed vocab, same rule as config `format`), never on agent id.

- **Builtin:** load `@ai-sdk/harness-*` packages as optionalDependencies (`claude-code`, `codex`, `pi`, `opencode`, `grok-build`, plus `cline` / `deepagents` / generic `acp` when a plugin declares them). Missing packages fail closed with the package name.
- **Custom HarnessV1:** in-repo adapters for runtimes the SDK does not ship yet — `cli` (Cursor, Copilot, Gemini, Aider, Goose until `@ai-sdk/harness-goose`) with spec `runtime.prompt` one-shot argv, `eve`, `sdk` (`generateSdkText` / ToolLoopAgent seam), `skip` (host/inference).
- **Sandbox:** host-process adapters default to `@ai-sdk/sandbox-just-bash`. Bridge adapters (Claude Code, Codex, OpenCode, …) require an injected network sandbox (`@ai-sdk/sandbox-vercel`); local Station/rift is not that sandbox. TTY seating remains mux/tmux.

In-repo contract: `createHarnessV1` / `createHarnessAgent` (`packages/code/src/ai-sdk-harness-runtime.ts`).

### Amendment (2026-11-08: hobo-code leaves main)

hobo-code (`packages/code`, `@hobo/code`, the `hobo-code` binary) is developed on the long-lived `feature/hobo-code` branch and is not part of `main`. The sections above, and the references below, describe that branch: the package, its release workflow and image, the isolation runbook and the experience proof exist there. So does its event family, the code.* events and the OpenFeature keys under `code.`: it is listed in `docs/design/event-families.md` on that branch only. `main` is merged into `feature/hobo-code` from time to time. This ADR is amended again when hobo-code is released to `main` or dropped.

### References
- Package: `packages/code` (`@hobo/code`)
- CLI: `hobo-code` section in `docs/design/cli-spec.md`
- Runbook: `docs/design/hobo-code-isolation-runbook.md`
- Experience proof: `src/draft/exp-proofs/dx/hobo-code-harness-experience`
- Eve / subagents: `packages/code/src/eve.ts`
- Secure stack: `packages/code/src/sandbox-stack.ts`
- Worlds: `packages/code/src/worlds.ts`
- Related: ADR-0130, ADR-0131, ADR-0134, ADR-0044, ADR-0083, ADR-0123, ADR-0128, HOBO-152, HOBO-394

## ADR-0152
**Atomic templates + local SQLite hybrid retrieval for zero-inference emission.**

**Status:** Accepted — extends [ADR-0139](#adr-0139) (hobo-code ScaffoldingAgent) and [ADR-0135](03-data-plane-sqlite-default.md) (one-writer SQLite).

### Context
Bo was emitting whole reference apps, or inventing Bindles with an LLM, for intents that already exist as literal snippets in `examples/`. A first atom slice used whole-file `atom.json` units and a process-local FTS5 index. That conflated topology, env injection, and handlers; skipped Tier-0 architecture-guard files; and left the embedder and confidence policy underspecified.

### Decision
1. **Atoms are parameterized multi-line snippets** under `packages/patterns/atoms/<id>/` (`meta.json` + `body/` + `acceptance.json`). Each atom declares `requires` / `provides` capability tags. They are not whole apps and not single lines. `hobo-code template` lists/renders them; chat emit stays on the session.
2. **Tier-0 architecture-guard atoms are mandatory:** konsistent layout, proto+CUE pair, Pact stub, package skeleton. Hello-world composition includes them so an emitted Bindle can pass architecture guards.
3. **Source of truth is the committed corpus.** The SQLite file at `$HOBO_HOME/durable/code/template-index.sqlite` is a rebuildable derived cache (one writer, WAL, `file://` offline fallback; NATS JetStream Object Store remains the preferred replica *target* for Station stores, not a second source of truth for atoms).
4. **Embedder pin:** `hobo-hashed-trigram-v1`, dim 256, n=3, FNV-1a, SHA-256 content hash of `id|dim|n|vocab`. Domain vocabulary includes bindle, campEnv, dependsOn, services__api__http__0, stationId, trail, junction, openFeature, litestream, NATS JetStream Object Store, konsistent, protobuf, cue, pact. `LocalEmbedder` is the ONNX/transformers.js swap slot. **No remote embedding API.**
5. **Hybrid retrieve:** FTS5 lexical + dense cosine (+ optional sqlite-vec `vec0` when `HOBO_SQLITE_VEC` loads) fused with RRF `k=60`. High confidence requires an FTS hit and fused score ≥ `0.018`. Default low-confidence behaviour is **refuse**. Escalate only when `allowEscalate` is set. Silent low-confidence emission is forbidden.
6. **Composition is in scope.** `composeAtoms` auto-satisfies requires from the corpus and topo-sorts; missing providers or cycles fail closed.
7. **Render is pure TypeScript `{{param}}` + Valibot.** No Handlebars, no EJS. No ts-morph in this decision.
8. **ScaffoldingAgent is additive.** `scaffoldHighValueTemplate` / `openui-astryx-bindle` stay unchanged. New path: `scaffoldFromIntent` / `scaffoldFromAtoms`. Emission is a **chat turn** in the `hobo-code` session (`tryWorkspaceAction`), not a retrieve subcommand. Full `examples/` apps remain composition proofs.
9. **No new protobuf family in `@hobo/code`.** Atoms are a file corpus, not an integration boundary. Parse-don't-validate is Valibot at the retrieve/fill boundary. Proto+CUE+PACT are *emitted* by Tier-0 atoms.
10. **Closed intent map is preferred over retrieval.** Phrases such as "deploy to azure" and "bundle apps in the same network" live in `templates/intents/*.json` and match before FTS/dense. A hit is score `1` and emits with zero inference.
11. **Entity-aware merge, not last-write-wins.** Snippets mark `/* @hobo.entity */`, `/* @hobo.slot strategy=append|union|once */`, and `/* @hobo.hole kind=trainable */`. Same path merges by entity+slot. Unmarked collisions and once-slot drift fail closed. "Same network" means two Camps in one Yard; "deploy to Azure" is a Yard `provider` pin, never a Bindle pin.
12. **Inference holes use `"use training"` / `training.define`.** First-pass PoCs emit trainable skeletons (ADR-0025 / ADR-0125), not invented handler logic. The training engine fills implementation specifics later.

### Amendment (entity-aware merge · closed intents · trainable holes)

The first ADR-0152 emit path overwrote files in topo order. That made "add a second Camp to the Azure Yard" unrepresentable without an LLM. Merge + the closed map close that: known HoBo phrases compile to an entity graph; only `@hobo.hole` regions are allowed to become inference later.

### Non-goals
- Shipping ONNX weights or a required native sqlite-vec dependency.
- ts-morph structural TypeScript surgery.
- Replacing `examples/` or the high-value OpenUI template.
- A second codegen CLI (HOBO-152 / HOBO-394 stay elevated, not forked).

### Amendment (2026-11-08: hobo-code leaves main)

The emission path in the `hobo-code` session (decisions 8 and 10: ScaffoldingAgent, `tryWorkspaceAction`, `templates/intents/*.json`) is on the `feature/hobo-code` branch, not `main`. The atom corpus itself stays in `packages/patterns` on `main`.

## ADR-0153
**Canonical `@hobo/patterns` catalog, ontology-vector retrieval, explicit `template` verb.**

**Status:** Accepted — supersedes ADR-0152 as the source of truth for pattern *bodies*. ADR-0152 chat emit remains for known session phrases.

### Context
#1087 shipped atoms inside `@hobo/code`. That created a second template system beside `hobo new` and `openui-astryx-bindle`. Retrieval used a hashed-trigram embedder. The product needed one catalog, typed contracts, calibrated abstention, and a zero-LLM route that is an explicit verb — not silent chat interception.

### Decision
1. **`@hobo/patterns` is the only catalog.** Manifests + renderings are canonical. SQLite/VS Code output is generated.
2. **Default vector is a generated ontology** from `@hobo/bindles` / `@hobo/capability-profiles` exports. No remote embeddings. No sqlite-vec.
3. **Zero-LLM guarantee is `hobo-code template` and `/template`.** Spies on model/dispatch seams stay at zero. Unprefixed chat is unchanged (#1087 create/run/debug stays).
4. **`hobo new` and `hobo-code scaffold` are adapters.** Public output contracts stay.
5. **Model2Vec is rejected** for this catalog size: would need install-time or committed weights. Ontology-vector + FTS/exact/RRF is enough.
6. **Structural apply uses the pinned TypeScript compiler API**, not ts-morph (second compiler identity + TS 6 lag) and not regex/line-number edits. CLI starter bodies live in `patterns/starter/cli/<alias>/project/`.
7. **Compatibility aliases** `todo|api|agent|fullstack` select `starter.cli.*` before concept aliases. Short alias uniqueness is enforced. `hobo new` writes whatever the catalog renders.

### Consequences
- **(+)** One package, proto+CUE, receipts, abstention, local SQLite index.
- **(+)** `hobo new` and `hobo-code scaffold` stay public adapters; OpenUI starter lives in the catalog.
- **(+)** Atomic snippets live in the catalog (`packages/patterns/atoms`) and are first-class `hobo-code template` / `/template` results. Chat emit still uses the same bodies.
- **(−)** Model2Vec rejected: no offline-packaged weights that clear no-download / no-native-compile gates.

### References
- Package: `packages/patterns/`
- Zero-LLM route: `hobo-code template`, `/template`
- Related: ADR-0135, ADR-0139, ADR-0152

### Amendment (2026-11-08: hobo-code leaves main)

The `hobo-code template` / `/template` route and the `hobo-code scaffold` adapter (decisions 3, 4 and the atom CLI in the consequences), and the OpenUI starter `starter.code.openui-astryx-bindle`, are on the `feature/hobo-code` branch, not `main`. On `main` the catalog is reached through `hobo new` and the `@hobo/patterns` library API, and apply receipts carry `promotionRef: "caller-promotes"`: promotion out of the isolation root is the caller's.

## ADR-0154
**Durable HoBo Code review aggregate.**

**Status:** Accepted

### Context
Git workbench snapshots are mutation surfaces. "Reviewed index" meant authorizing a staged tree, not recording what a human inspected. Diffs and threads cannot live on the resident session event stream.

### Decision
1. Review commands/snapshots are `hobo.code.review-command/v1` and `hobo.code.review-snapshot/v1`.
2. Persistence is EventStore partition `hobo-code-reviews`, stream `code-review:<id>`.
3. Diff bytes are content-addressed outside session events.
4. Coverage and threads are generation-bound. Re-anchoring is explicit (exact / unique-context / stale / ambiguous).
5. GitHub publish, hunk stage, and suggestion apply use exact-effect digests plus HEAD/index revalidation.
6. Inbox is a derived projection, not the aggregate.

### Consequences
- **(+)** Terminal, CLI, and browser share one parse-don't-validate contract.
- **(−)** GitHub CLI (`gh`) is the live provider; tests use a fake provider plus a real temporary Git repository.

### Amendment (2026-11-08: hobo-code leaves main)

The review aggregate is part of `@hobo/code`, which is developed on the `feature/hobo-code` branch and is not part of `main`. This ADR describes that branch.

## ADR-0160
**`drizzle-kit` is the default relational schema-diff engine behind the migration port — deploy-owned generation, HoBo-gated apply.**

**Status:** Accepted — implements the diff engine [ADR-0032](#adr-0032) decision 1 specifies for the `hobo:data/relational` Postgres reference; consistent with the `POSTGRES_MIGRATION_TOOLS` product-claim axis in `@hobo/data-postgres`; informed by the [Alchemy capture](../../competitors/alchemy.md#feature-surface) Drizzle workflow.

### Context
ADR-0032 commits to declarative desired-schema + auto-diff with a reviewable migration plan and gated expand→backfill→contract apply — but names no diff engine, so the decision's primary surface has no default implementation. `drizzle-kit` already appears in HoBo as a *product-claim* capability flag ("Migration tools whose compatibility is a product claim, not an inference"), and Alchemy's Drizzle integration demonstrates the ergonomic bar: a plain TypeScript schema module drives both typed queries and migration generation, and generation is **deploy-owned** — `Drizzle.Schema` "diffs your schema module against the latest snapshot," with "No CI generation step — the deploy owns it" and ordering falling out of the dependency graph.

### Decision
1. **`drizzle-kit` is the default implementation of the relational schema-diff engine** for `hobo:data/relational` (Postgres reference). It is an internal dependency of the migration-engine adapter — never public API, never a runtime dependency of the data path (`hobo:data` clients stay port-generated; no `drizzle-orm` in handlers). Alternative engines (`atlas`, `prisma-migrate`, raw SQL escape hatch) remain swappable adapters, and the `POSTGRES_MIGRATION_TOOLS` product claims gate which engines may run against which endpoints — a serverless HTTP-only Postgres that cannot run a tool refuses it structurally.
2. **Deploy-owned generation, HoBo-gated apply — and HoBo owns the plan.** The diff runs at the `plan` phase (ADR-0158) against the schema live in the target Camp, emitting the reviewable migration plan (`migration.Planned`) and generated SQL as a content-addressed artifact — no separate CI generation step, matching the Alchemy bar. Two boundaries keep a third-party generator from becoming a determinism hole: **HoBo owns the canonical schema IR and the expand/backfill/contract phase plan** (computed in-repo, deterministically, so the plan is stable even where SQL emission is unavailable), and the **engine's version is pinned into the artifact digest**, so a drizzle-kit upgrade surfaces as a visible plan change rather than silent SQL drift. SQL emission and Drizzle-module ingestion are toolchain-gated and fail closed with remediation — never a silent fallback. Apply is where HoBo deliberately diverges from Alchemy's transactional directory-scan: the ADR-0032 **expand → backfill → contract** gated saga, forward-only, snapshot-before-contract.
3. **Drizzle schema modules are an accepted authoring input.** HoBo's declarative schema stays canonical; a Drizzle schema module is parsed (parse-don't-validate) into the canonical schema IR by a thin adapter so existing Drizzle users adopt without rewriting. Impedance is documented per the ADR-0144 rule — constructs that don't map (dialect-specific column tricks) are named, not silently dropped.

### Non-goals
- No MySQL default in this ADR (the Postgres reference is the ADR-0032 v1 scope).
- No ORM endorsement in the runtime data path; this is a migration-engine decision only.

### Consequences
- **(+)** ADR-0032's diff engine ships with a battle-tested default instead of a bespoke differ; the OOB story matches the best shipping DX while keeping gated, forward-only apply.
- **(+)** Drizzle-native teams onboard with their existing schema modules.
- **(−)** An external tool sits behind a core port: version pinning and output canonicalization (deterministic artifacts from a third-party generator) become HoBo's responsibility.

## ADR-0163
**Drift is a derived fact computed from the deployment view, not stored state — classified by typed lifecycle, with `converging` and `unknown` as first-class answers.**

**Status:** Accepted — derives from the event-sourced authority of [ADR-0135](03-data-plane-sqlite-default.md) and the typed-contract argument of [ADR-0136](03-data-plane-effects-resiliency.md); prompted by the [Argo CD capture](../../competitors/argo-cd.md#where-argo-cd-is-stronger) and the corpus-wide finding in [gap analysis §7.1](../../competitors/gap-analysis.md#71-new-architecture-level-gaps).

### Context
HoBo already holds both halves of the comparison. `DeploymentViewRow` carries the plan — recorded intent — and the per-resource lifecycle folded from `resource.*` facts — materialized reality. Nothing derived the difference, so a divergence was discovered only when somebody went to look.

Argo CD's `OutOfSync` plus a per-resource diff is the most valuable idea in that category and the reason its UI is load-bearing during an incident. Reconciliation is table stakes; *showing a human the difference* is what people actually use. HoBo owned the harder half and not the visible one.

### Decision
1. **Derive, never store.** `computeDrift(row)` is a pure function over a view that already exists — no new event, no new state, no reconciler. A stored drift flag is a fourth thing that can go stale; a derived one is correct whenever the view is and rebuilds from zero with the log.
2. **Classify by typed lifecycle, not by field diff.** The known failure mode of this category is *false* drift: field-level comparison reports every defaulted value, server-side mutation and controller write-back, so teams add ignore rules until the surface is blind to the real thing. Classification keys on lifecycle states, which mean something definite — the same argument ADR-0136 makes for typed contracts.
3. **Four statuses, not two.** `converging` covers work in flight: a resource mid-provision is the plan being carried out, and a two-state model must call that either drift (false alarm every deploy) or in-sync (a lie until it settles). `unknown` covers a deployment with no plan, or one rejected or rolled back, where there is nothing to compare — reporting "no drift" there would be a clean bill of health for something nobody described.
4. **A real divergence outranks in-flight work.** A failure is actionable now; reporting `converging` while a resource has already failed buries the actionable half.
5. **Imported estates do not report extra resources as drift.** `hobo import` ([ADR-0041](07-portability-extensibility.md#adr-0041)) adopts things HoBo did not create; flagging all of them on the first run would make the report useless exactly where adoption needs it. Adoption excuses extra resources, never missing ones.
6. **Destroyed-and-unplanned is not a finding.** Gone is gone; flagging it forever is the noise that trains people to stop reading the report.

### Consequences
- **(+)** The most-repeated gap in the competitive corpus closes with a pure function over existing state — no new plane, no new persistence.
- **(+)** `converging` and `unknown` remove the two ways a two-state model lies, which is what drives ignore-rule accumulation elsewhere.
- **(+)** Gives the browsable topology surface its content: the resource tree needs something to colour, and this is it.
- **(−)** Resolution is per-resource, not per-field. A resource that exists but is *misconfigured* reads as in-sync. Closing that needs provider-side state readback, which is a larger decision and deliberately not taken here.
- **(−)** Accuracy is bounded by the fidelity of `resource.*` facts. A provider that does not report destruction leaves a resource looking realized.

## ADR-0166
**Estimate-versus-actual is a derived report with explicit refusals: integer minor units, unestimated cost never dropped, unrealized estimates excluded from variance, and a short observed window refused rather than reported as a saving.**

**Status:** Accepted — extends [ADR-0039](02-identity-security.md#adr-0039) (cost governance), Plan 5 (plan-time estimation), and [ADR-0135](03-data-plane-sqlite-default.md) (event-sourced authority); informed by the [Infracost](../../competitors/infracost.md), [Kubecost](../../competitors/kubecost.md), [Vantage](../../competitors/vantage.md) and [OpenCost](../../competitors/opencost.md) captures; closes gap N4 in [gap-analysis](../../competitors/gap-analysis.md).

### Context
No product in the FinOps corpus compares its own estimate to the bill for the same workload. Infracost estimates at plan time and never sees actuals, so it structurally cannot learn that its estimates are systematically wrong; Kubecost, Vantage and OpenCost measure actuals and never see the estimate. The loop is open in every one of them, and it is open because closing it means holding both facts in one authoritative place — which is what an append-only deployment log already is. This is the clearest genuinely novel feature the cohort leaves on the table, and it is defensible for a structural reason rather than an effort reason.

### Decision
1. **`reconcileCost` is a pure function, not a service.** A recorded estimate plus observed actuals in, a variance report out. No new event family, no stored reconciliation state, no job — the same derive-don't-store argument as [ADR-0163](#adr-0163).
2. **Integer minor units, one currency per report.** The repo carries four incompatible money conventions today: decimal strings on the catalog (`marginalPrice`), floats named `*Usd` in the broker and policy planes, `amount: number` in parsed cost documents, and minor units in the connectivity billing aggregator. Float accumulation is how a total lands a cent away from the invoice, and a cent is enough to get the whole surface disbelieved. Mixed currencies are refused (`currency-mismatch`) rather than summed: without an FX rate, adding them yields a number wrong in a way no reader can see.
3. **The report must sum to the invoice.** An actual with no matching estimate is reported as `unestimated` and counted toward the total. OpenCost's idle-as-residual design exists because a cost surface that quietly omits a line is one nobody trusts twice.
4. **A short observed window is refused, not reported.** Three days of actuals against a month's estimate is a 90% underspend that is entirely an artifact of the clock. Below full coverage the status is `insufficient-window` and no variance is computed — but both totals and the coverage fraction are still reported, because refusing the comparison is not refusing the facts.
5. **Unrealized estimates are a separate line.** An estimate for a resource that was never charged for is an estimate that was never tested, not a saving. Folding it into the variance would let a half-failed deployment read as good cost control.
6. **Status follows the findings, totals stay exact.** A tolerance-suppressed difference does not move the status, so the summary can never say "over" beside an empty finding list — but `totals.varianceMinorUnits` remains the exact figure that has to agree with the bill. Tolerance is expressed in basis points of the estimate and defaults to zero, so slack has to be asked for by name.

### Non-goals
- Not a pricing engine. What an estimate *should* be is N5's problem; this reconciles whatever estimate was recorded against whatever actuals were observed, which is why it is not gated on multi-provider price data.
- Not budget enforcement. Enforcement at admission ([ADR-0039](02-identity-security.md#adr-0039) §2) remains the separate differentiated claim, and remains design-only.
- No repo-wide money-type migration. This module fixes its own representation; unifying the other three conventions is its own work.

### Consequences
- **(+)** HoBo can state, per deployment, whether its own estimate held — the thing no product in the cohort can say about itself.
- **(+)** The three refusals are the difference between a number finance checks once and a number finance checks monthly.
- **(−)** Callers must convert into minor units at the boundary, and the catalog's decimal-string prices have no converter yet.
- **(−)** Nothing produces the actuals side yet: `meter.UsageRecorded` has no producer outside tests, and the connectivity billing aggregator is not wired to deployments. The loop is closed as a computation before it is closed as a pipeline, and no surface may claim otherwise.
