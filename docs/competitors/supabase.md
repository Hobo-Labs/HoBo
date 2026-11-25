---
type: Competitive Reference
title: "Supabase — competitor reference"
description: "Supabase is the leading **open-source Firebase alternative** — a **Postgres-centric backend-as-a-service** that gives every project a dedicated PostgreSQL database wrapped in an integrated suite (Auth, REST/GraphQL, Realtime, Storage, Edge Functions, pgvect"
tags: [hobo, competitors]
competitor:
  slug: supabase
  name: "Supabase"
  primary_category: backend-data-platforms
  categories: [backend-data-platforms]
  directness: adjacent
  role: "open-source Postgres BaaS — adjacent platform and possible provider target"
  posture: [provider-target, benchmark]
  hobo_surface: [typed-contracts, identity-secrets]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://supabase.com/docs
    - https://github.com/supabase/supabase
---

# Supabase — competitor reference

> A faithful capture of **Supabase** for HoBo competitive analysis — the leading **open-source Firebase alternative / Postgres backend-as-a-service (BaaS)**: a dedicated Postgres database wrapped in **Auth (GoTrue), Row Level Security, Realtime (Postgres Changes / Broadcast / Presence), Storage, Edge Functions (Deno), and pgvector**, all open-source and self-hostable. Unlike HoBo's closest analogs (Encore/Nitric, which are infrastructure-from-code into *your own* cloud), Supabase is a **managed BaaS on its own platform** (though fully self-hostable) — an **adjacent BaaS** like Convex/InsForge, and a **possible HoBo provider target** (a backend HoBo could deploy *onto*, the way `hobo:auth` already names Supabase Auth as an adapter). Sources: [supabase.com](https://supabase.com/) · [supabase.com/docs](https://supabase.com/docs) · [github.com/supabase/supabase](https://github.com/supabase/supabase) · [supabase.com/pricing](https://supabase.com/pricing) · [supabase.com/docs/guides/realtime](https://supabase.com/docs/guides/realtime). License **Apache-2.0** (core repo; components under permissive OSS — MIT/Apache/PostgreSQL). Researched July 2026; API/CLI/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Supabase is the leading **open-source Firebase alternative** — a **Postgres-centric backend-as-a-service** ("**The Postgres development platform**", tagline *"Build in a weekend. Scale to millions."*) that gives every project a **dedicated PostgreSQL database** wrapped in an integrated suite that *"work[s] together out of the box"*: **Supabase Auth (GoTrue)**, **auto-generated REST (PostgREST) and GraphQL (`pg_graphql`) APIs**, **Realtime**, **Storage**, **Edge Functions (Deno)**, and a **pgvector-based AI/Vector toolkit** — all **open-source (Apache-2.0) and self-hostable**. Because the substrate is real Postgres (not a bespoke store), Supabase leans on *"the predictability of SQL and the freedom to self-host"* and pitches the database as **fully portable, no vendor lock-in**.

The mental model is **"the database *is* the backend."** Everything hangs off one Postgres: end-user accounts live in an `auth` schema; **Row Level Security (RLS) policies keyed on `auth.uid()`** are the authorization model; the REST/GraphQL APIs are **generated from your schema**; **Realtime** tails the Postgres **write-ahead log (WAL)**; **Vector** is the `pgvector` extension; **Storage** permissions are Postgres rows. You author SQL + policies, and the platform exposes them over HTTP/WebSocket with generated client libraries (`supabase-js` and Flutter/Swift/Python/…). This is the inverse of HoBo's bet: Supabase makes **Postgres the single substrate** and goes deep; HoBo makes the substrate **pluggable** — any cloud, any data paradigm — behind language-neutral WIT ports, and can consume a BaaS like Supabase as *one provider*.

Supabase is **mature and massively adopted** — ~105k GitHub stars, a **$5B valuation (Oct 2025)**, and years of production usage — a shipping, proven product. (HoBo, by contrast, is design-phase; the comparisons below credit Supabase's shipped depth heavily and flag where Supabase ships what HoBo has only *designed*.)

| Dimension | Supabase |
|---|---|
| Positioning | **Open-source Firebase alternative / Postgres BaaS** — *"Build in a weekend. Scale to millions."* |
| Substrate | A **dedicated PostgreSQL database** per project (+ extensions); one Postgres is the whole backend |
| Data / API | Postgres + **auto-generated REST (PostgREST)** & **GraphQL (`pg_graphql`)** from your schema; **Row Level Security** authz |
| Auth | **Supabase Auth (GoTrue)** — email/password, magic link, phone/OTP, **20+ OAuth providers**, SSO/SAML, anonymous, OAuth2.1 server; issues **JWTs** consumed by RLS via `auth.uid()` |
| Realtime | **Elixir/Phoenix** server, WebSockets — **Postgres Changes** (WAL), **Broadcast** (pub/sub), **Presence** (shared awareness) |
| Storage | **S3-compatible** object storage + global **CDN** + on-the-fly **image transforms**; access via Postgres RLS; resumable uploads |
| Functions | **Edge Functions** — TypeScript on **Deno** (Supabase Edge Runtime), globally distributed; edge gateway does JWT validation |
| AI / Vector | **`pgvector`** embeddings in-database; semantic / keyword / **hybrid search**; embedding gen in Edge Functions; **Vector Buckets** (public alpha, late 2025) |
| CLI / dev | **`supabase` CLI** — full local **Docker** stack (Studio · Postgres · PostgREST · Realtime · Storage · Auth · Edge Functions · Mailpit), migrations, `functions`, **branching**, `gen types` |
| Deploy | **Managed cloud** (its own platform) **or** **self-host via Docker Compose** (community-supported; some platform features excluded) |
| License / price | **Apache-2.0** OSS core; **Free $0** / **Pro $25/mo** + usage / **Team $599/mo** / Enterprise; **compute billed hourly per project** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Postgres** | The actual product — everything else is a service around a real Postgres database |
| **Row Level Security (RLS)** | Authorization expressed as database policy rather than application code |
| **PostgREST** | The auto-generated REST API over the schema |
| **Realtime** | Change streams and presence over Postgres replication |
| **Auth (GoTrue)** | Identity, sessions and JWTs that RLS policies consume |
| **Storage / Edge Functions / pgvector** | Object storage, serverless compute, and vector search |

The mental model is **Postgres with the boring parts built**. Supabase's insight is that a real
database with a real schema is the right foundation, and that most backend work is the plumbing
around it — so ship the plumbing and leave the database standard.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `typed-contracts` | Schema-derived types and an auto-generated API |
| `identity-secrets` | Auth plus RLS is authorization at the data layer |
| `runtime-portability` | **Genuinely strong**: it is Postgres, and Postgres runs everywhere |

Supabase is a **provider target** for HoBo's data and auth ports rather than a competitor for the
control plane.

## Feature surface

### Postgres, APIs & Row Level Security

Each project is a **full dedicated Postgres** (not a fork), with extensions and full SQL — joins, foreign keys, transactions, functions, triggers. Supabase **auto-generates a REST API** from the schema via **PostgREST** and a **GraphQL API** via the **`pg_graphql`** extension. Authorization is **Postgres Row Level Security**: *"RLS must always be enabled on any tables stored in an exposed schema."* You enable and write policies in SQL:

```sql
alter table profiles enable row level security;

create policy "User can see their own profile only."
on profiles for select
using ( (select auth.uid()) = user_id );
```

Requests are mapped to Postgres roles **`anon`** (unauthenticated) and **`authenticated`** (logged-in), and policies gate per-role via a `TO` clause. `auth.uid()` returns the JWT subject; once RLS is on, *"no data will be accessible via the API when using a publishable key, until you create policies."* **RLS is Supabase's multi-tenant / per-user isolation mechanism — enforced in the database itself**, so it holds wherever the DB is reached.

### Auth (Supabase Auth / GoTrue)

**Supabase Auth** (the service historically called **GoTrue**, repo now `supabase/auth`) is *"a JWT based API for managing users and issuing JWT tokens"* (Go). It supports **email/password, magic links, phone/OTP, anonymous sign-in, 20+ social OAuth providers, SSO/SAML**, custom OAuth/OIDC providers, and (newer) an **OAuth 2.1 server**. Users live in the project's `auth` schema; issued **JWTs flow straight into RLS** via `auth.uid()`, closing the loop between identity and row-level authorization. In self-host, providers are configured with `GOTRUE_EXTERNAL_*` env vars.

### Realtime (Postgres Changes / Broadcast / Presence)

Realtime is an **Elixir/Phoenix** server exposing three mechanisms over **WebSockets**:

- **Postgres Changes** — streams **WAL** insert/update/delete events to **authorized** clients: *"the cluster connects to your Postgres database and starts streaming changes from a replication slot."*
- **Broadcast** — low-latency **client↔client pub/sub** over named channels; can also **broadcast from the database** (writes to a `realtime.messages` publication the server tails).
- **Presence** — *"track and synchronize shared state between clients"* (who's online, cursors, typing, live selection) — the current-state view of a channel, not a stream. **First-class and shipping.**

> **Honesty hook:** Supabase's **Presence is a shipped, first-class feature.** HoBo has only *designed* the equivalent — presence as a **composition** of `websocket` rooms + the reactor + the new `cache` port, with a `@hobo/presence` opt-in package ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)). This is a place a mature competitor ships what HoBo has on paper.

### Storage

**S3-compatible** object storage with a **global CDN**, on-the-fly **image transformations**, and **resumable uploads**. Access control reuses the same **Postgres RLS** (a bucket's objects are governed by policies), so storage authz composes with the rest of the app's row-level rules.

### Edge Functions (Deno)

Edge Functions run on the **"Supabase Edge Runtime (Deno compatible runtime with TypeScript first)"** — authored as `.ts` files exporting a handler, **globally distributed for low latency**. Requests pass through an **edge gateway that handles routing, JWT validation, and auth** before the nearest regional runtime executes; functions reach Postgres via `supabase-js` or a **pooled/serverless-friendly connection** (*"treat Postgres like a remote, pooled service"*). CLI loop:

```bash
supabase functions new <name>      # scaffold
supabase functions serve           # run locally (Deno)
supabase functions deploy <name>   # ship (CLI / Dashboard / MCP)
```

### CLI, migrations & branching

The **`supabase` CLI** boots the **entire stack locally in Docker** — Studio, Postgres, PostgREST, Realtime, Storage, Auth (GoTrue), Edge Functions, plus Mailpit (local SMTP) and a diff tool — printing local credentials on start:

```bash
supabase init                      # new local project
supabase start | stop              # bring the local Docker stack up/down
supabase link                      # link to a remote project
supabase migration new <name>      # timestamped SQL in supabase/migrations/
supabase db diff                   # generate a schema diff
supabase db push                   # apply migrations to the remote DB
supabase db pull                   # capture remote state into a migration
supabase db reset                  # reapply migrations + seed locally
supabase gen types typescript      # typed client from the schema
```

**Migrations** are **timestamped SQL files** in `supabase/migrations/` (`<timestamp>_create_employees_table.sql`), *"applied in timestamp order."* **Branching** (GitHub integration or dashboard) creates a **branch per Git branch / PR**: each gets *"a separate environment with its own Supabase instance and API credentials"* — migrations from `main` applied, health checks (Auth/API/DB/Storage/Realtime), optional **seed** data, and **Edge Functions deployed**. Branches are **ephemeral preview** (paused/deleted on merge) or **persistent** (staging/QA); *"new branches do not start with any data from your main project."*

### AI / Vector (pgvector) & the MCP server

The AI toolkit's thesis is *"the best vector database is the database you already have"*: **`pgvector`** columns store and index embeddings **inside the same Postgres**, with **semantic, keyword, and hybrid search**, **embedding generation directly in Edge Functions**, and integrations (OpenAI, Hugging Face, LangChain) plus a Python client for unstructured embeddings. **Vector Buckets** (public alpha, late 2025) add specialized cold storage for embeddings with an attached query engine.

The **Supabase MCP server** (`https://mcp.supabase.com/mcp`, OAuth via dynamic client registration; `http://localhost:54321/mcp` locally) exposes tools to AI assistants to **list tables, execute SQL, apply migrations, deploy/list Edge Functions, manage branches (merge/rebase), fetch logs & security/performance advisors, generate TypeScript types, manage projects/orgs/cost, and search docs** — all *"operating under the developer's permissions and security scope."*

### Self-hosting & pricing

**Self-host** is *"the fastest and recommended way … use Docker"* — a **Docker Compose** stack of the core services (Postgres, Auth/GoTrue, PostgREST, Realtime, Storage, a **Kong** API gateway, Studio) that *"mimics a single project"* and *"does not phone home."* It is **community-supported**, and **platform-only features are unavailable**: *"branching, advanced metrics beyond logs, managed backups and PITR, analytics and vector buckets, ETL, and the platform management API."*

**Pricing** (usage-based over a base fee):

- **Free — $0/mo:** 50,000 MAU, 500 MB database, 1 GB file storage, 5 GB egress (+5 GB cached); projects **pause after 1 week** of inactivity; max **2 active** projects.
- **Pro — $25/mo + usage:** 100,000 MAU (then **$0.00325/MAU**), 8 GB disk (then **$0.125/GB**), 100 GB storage, 250 GB egress (then **$0.09/GB**), 2M Edge Function invocations (then **$2/1M**), **$10/mo compute credits** (covers one Micro instance).
- **Team — $599/mo:** all Pro, plus SOC2 & ISO 27001, 14-day backups, 28-day log retention, priority SLAs, project-scoped access.
- **Enterprise — custom:** designated support, 24×7 support, BYO-cloud, uptime SLAs, custom limits.
- **Compute** is *"billed hourly. Each project runs its own instance"* — **Micro $10/mo up to 16XL $3,730/mo**.

## Architecture

- **Postgres is the centre**, not an implementation detail: schema, extensions, RLS and replication
  are the mechanism for everything above.
- **Services around it** — PostgREST for the API, GoTrue for auth, Realtime for change streams,
  Storage for objects — each independently deployable and open source.
- **RLS as the authorization model** means policy lives with the data and applies to every client
  regardless of path, which is a stronger property than middleware checks.
- **State authority** — Postgres.
- **Portability boundary** — **the best in this cohort.** The database is standard Postgres; a dump
  restores anywhere. What does not travel is the surrounding services' configuration, and even those
  are open source and self-hostable.

## Where Supabase is stronger

> Shipped, evidenced capability only.

### what Supabase does well

- **Postgres depth, not a bespoke store** — a real dedicated Postgres per project: 30+ years of Postgres, full SQL/joins/transactions/extensions, and a **portable, no-lock-in** database you can `pg_dump` out.
- **Coherent, integrated BaaS** — Auth + REST/GraphQL + Realtime + Storage + Edge Functions + Vector that *"work together out of the box"*; **best-in-class BaaS DX**.
- **RLS as authorization** — declarative, **in-database**, per-row/per-tenant access keyed to `auth.uid()`, enforced everywhere the DB is reached.
- **Realtime with first-class, shipping Presence** — Postgres Changes + Broadcast + **Presence**, at scale.
- **Genuinely open-source (Apache-2.0) and self-hostable** — a full Docker Compose stack, not a token OSS core.
- **Strong local-dev fidelity** — the CLI runs the **entire stack in Docker**, with **migrations, branching, and generated types**.
- **In-database AI** — `pgvector` embeddings + hybrid search + Vector Buckets, no separate vector DB.
- **Mature and massively adopted** — ~105k stars, $5B valuation, huge ecosystem: a **proven, shipping product** (where HoBo is design-phase).
- **MCP server** — AI agents introspect and manage projects (SQL, migrations, functions, branches) under the developer's scope.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Supabase's limits — HoBo's opening

- **Single Postgres backend — not cloud-/paradigm-agnostic.** Everything *is* Postgres + extensions. There is **no multi-cloud provider portability, no pluggable IaC, no "same app → N clouds"**, and **no non-SQL paradigm** as a first-class primitive (document/graph/wide-column/OLAP are "use an extension or bolt it on"). HoBo is genuinely multi-cloud with **cloud-agnostic WIT ports + pluggable IaC** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) and a **paradigm taxonomy** with opt-in packages ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0081](../design/adr/03-data-plane.md#adr-0081)).
- **It is Supabase's own platform** — self-host is real but **loses platform features** (branching, PITR, managed backups, advanced analytics, Vector Buckets, ETL, management API) and is community-supported: **self-host ≠ hosted parity**. HoBo's **Yard is itself a Bindle** — self-host = hosted parity ([Plan 4](../design/control-plane.md#plan-04)) — and monetization is out of scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).
- **No durable event-sourced control plane / audit-replay.** Realtime tails the WAL, but there is **no event-sourced runtime, no replayable command log, no governed audit trail** over the platform. HoBo's data plane is **event-sourced + CQRS with a reactor** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No auditable Matching / Resource Definitions / Dispatcher.** The backing services are **fixed** (Postgres + Supabase's stack); there is no "same app, different infra per environment, recorded as a decision." HoBo adds **Resource Definitions + Matching** (recorded `match.Decided`) + the cost-aware **Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No agents-as-principals / generation pipeline.** The MCP server acts **under the developer's credentials**, not distinct **agent identities (SVIDs)**; provider/feature breadth is human-built. HoBo makes **agents first-class principals with brokered tokens** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) and **AI-generates providers/implementations** ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **No cross-cloud portability / language-neutral runtime.** Edge Functions are **Deno/TS only**, and the whole product is one region-replicated Postgres platform. HoBo's runtime contract is **language-neutral WIT/wasm** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) with **cross-cloud data** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)/[ADR-0040](../design/adr/01-architecture-core.md#adr-0040)).
- **Multi-tenancy is RLS — a building block, not an app-tenant model.** No tenancy-model spectrum, per-tenant isolation-by-construction, quota/residency/lifecycle, or cross-tenant-leak gate. HoBo ships **multi-tenant-app primitives** ([ADR-0079](../design/adr/02-identity-security.md#adr-0079)/[ADR-0080](../design/adr/02-identity-security.md#adr-0080)).
- **Usage/compute pricing scales with usage — by design.** MAU, egress, storage, and **hourly per-project compute** all meter. HoBo removes **billing/monetization** from scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); metering/showback is OSS FinOps ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)).

## Adversarial critique

- **RLS is powerful and easy to get wrong.** Authorization expressed as SQL policy is elegant and
  concentrates risk in a place many teams review less carefully than application code; a wrong policy
  is a data breach.
- **The auto-generated API couples the client to the schema**, so a refactor is a breaking change for
  every consumer.
- **Realtime is replication-derived**, not a query-invalidation engine — it tells you rows changed,
  not that your answer changed, which is a meaningfully weaker contract than Convex's.
- **Self-hosting the full stack is substantially harder than using the hosted product**, and the gap
  between the two is where most operational surprises live.
- **Connection management** is the classic Postgres-at-scale problem and arrives with serverless
  clients.
- **Breadth versus depth** — auth, storage, functions and vector search each compete with specialists.

### Comparisons with adjacent tools

- **vs HoBo:** Supabase is a **mature, shipping, single-Postgres open-source BaaS on its own (self-hostable) platform**; HoBo is a **design-phase cloud-agnostic meta-cloud** — many clouds, many paradigms, event-sourced + AI-native + governed. Supabase **sets the BaaS DX bar** and ships Realtime **Presence** that HoBo only just *designed* as a composition of `websocket` rooms + reactor + the new `cache` port + an opt-in `@hobo/presence` package ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)). Honest read: HoBo is **behind on shipped collaboration primitives**, ahead on **breadth + governance + AI-native depth + cross-cloud portability**.
- **vs Convex / InsForge:** adjacent BaaS. Supabase is **Postgres/SQL-first, open-source, self-hostable**; Convex is a reactive **document DB** with TypeScript functions; InsForge is an **AI-agent-native** BaaS. All three are **possible HoBo provider targets** — backends HoBo could deploy *onto* (Supabase Auth is **already a named `hobo:auth` adapter**; a Supabase Postgres could realize `hobo:data`, its Storage a `bucket`).
- **vs Firebase:** the incumbent Supabase is defined against — **Postgres/SQL + open-source + RLS** vs **Firestore/NoSQL + proprietary**. HoBo is agnostic to both and could target either.
- **vs Encore / Nitric:** those are **infrastructure-from-code into *your own* cloud account**; Supabase is a **managed BaaS** (its own platform, self-hostable) — architecturally **closer to Convex than to Encore**. HoBo spans both: authoring/IfC **plus** a governed multi-cloud control plane, and it can **consume a BaaS like Supabase as one provider**.

**Net:** Supabase is the **leading open-source Postgres BaaS** — real Postgres depth, RLS, Auth, Realtime (incl. shipping **Presence**), Storage, Edge Functions, and `pgvector`, with huge adoption and best-in-class BaaS DX — and it even **ships collaboration primitives HoBo has only designed** ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)). But it is a **single-Postgres-backend, own-platform** product. HoBo's differentiation is the surrounding **meta-cloud**: cloud-agnostic ports + pluggable IaC, multi-paradigm data, an event-sourced governed control plane (Matching/Dispatcher/cost/policy), agents-as-principals + a generation pipeline, cross-cloud portability, multi-tenant-app primitives, and self-host = hosted parity — **and HoBo can target Supabase itself as one provider among many**.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Supabase concept (✅ has · ➕ goes further · ◐ thin/partial · 🔜 designed-not-shipped · ✗ out-of-scope-by-design). HoBo is **design-phase**; Supabase is **shipping** — statuses describe HoBo's *design* parity, not running software.

| Supabase concept | HoBo equivalent | Status / notes |
|---|---|---|
| **Supabase Auth (GoTrue)** — JWT + OAuth/SSO user store | **`hobo:auth` port** — federate + verify any IdP; **Supabase Auth is a *named adapter*** ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)/[ADR-0073](../design/adr/07-portability-extensibility.md#adr-0073)) | ✅ HoBo **federates** rather than shipping its own user store — Supabase Auth is literally in the catalog row |
| Dedicated **Postgres** + SQL + REST/GraphQL | **`hobo:data` port** ([ADR-0112](../design/adr/03-data-plane.md#adr-0112)) + **GraphQL facade generation** ([ADR-0089](../design/adr/03-data-plane.md#adr-0089)) + **paradigm packages** `@hobo/sql/vector/graph/document` ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ✅/➕ SQL is **one paradigm of many**, mapped to cloud natives by Matching, overridable |
| **Row Level Security** (per-row/tenant authz) | **Tenant isolation by construction** + cross-tenant-leak gate ([ADR-0079](../design/adr/02-identity-security.md#adr-0079)/[ADR-0080](../design/adr/02-identity-security.md#adr-0080)); `.allow()` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ➕ RLS is a DB **building block**; HoBo ships a full **app-tenant model** |
| Realtime **Postgres Changes** (WAL stream) | **Event-sourced reactor** + streaming RX reads ([ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ✅ HoBo streams from an **event log / projections**, not WAL-tailing |
| Realtime **Broadcast** (pub/sub channels) | **`websocket()` rooms** + `wasi:messaging` ([ADR-0075](../design/adr/07-portability-extensibility.md#adr-0075)) | ✅ |
| Realtime **Presence** (shared awareness) | **Presence disposition** — rooms + reactor + **`cache`**, `@hobo/presence` opt-in package ([ADR-0119](../design/adr/03-data-plane.md#adr-0119), atop the `cache` port [ADR-0118](../design/adr/03-data-plane.md#adr-0118)) | 🔜 **Supabase ships this; HoBo has just *designed* it** — the honest gap on shipped collaboration |
| **Storage** (S3-compat + CDN + transforms) | **`bucket`** / `wasi:blobstore` (+ presigned URLs, `hobo:blob-events`) | ✅ |
| **Edge Functions** (Deno/TS) | **`service`** = wasm/wasi component, **any language** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ polyglot + capability-secure, not Deno-only |
| **pgvector / Vector** (embeddings, hybrid search) | **Vector paradigm package** `@hobo/vector` ([ADR-0081](../design/adr/03-data-plane.md#adr-0081)); search = query side of the data plane ([ADR-0034](../design/adr/03-data-plane.md#adr-0034)) | ✅ |
| **Migrations** (`supabase/migrations/*.sql`) | **SQL migrations** + data portability / schema-versioning ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) | ✅ declarative desired-schema + auto-diff |
| **Branching** (preview branch per PR) | **Ephemeral/preview Camps** + sandbox lanes ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0076](../design/adr/02-identity-security.md#adr-0076)) | ✅/➕ |
| CLI **local Docker stack** (`supabase start`) | **`hobo dev`** on `runtime-local` + fidelity matrix ([Plan 7](../design/developer-experience.md#plan-07)/[ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) + local dashboard ([ADR-0111](../design/adr/07-portability-extensibility.md#adr-0111)) | ✅/➕ |
| **MCP server** (agent manages the project) | **`@hobo/mcp` control surface** + MCP as first-class ([ADR-0014](../design/adr/03-data-plane.md#adr-0014)); agents as **principals with SVIDs + brokered tokens** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ✅/➕ agents are **audited principals**, not developer-credential proxies |
| **Self-host** (Docker Compose; platform features excluded) | **Yard-is-a-Bindle** — self-host = hosted parity ([Plan 4](../design/control-plane.md#plan-04)); OSS, **no billing** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ➕ **no feature-gap** between self-host and hosted |
| (ephemeral realtime/presence state) | New **`cache` port** `hobo:cache` — ephemeral, TTL-first, evictable ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)) | ✅ the missing piece presence composes on |
| **Managed BaaS on Supabase's platform** | **HoBo could TARGET Supabase as a provider** (like Convex/InsForge) — a backend HoBo deploys *onto* | ➕ Supabase = **provider target**, not only competitor |
| **Usage / compute pricing** (MAU/egress/compute) | **Out of scope by design** — no billing/monetization ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); metering/showback is OSS FinOps ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗ by design |

### Where Supabase is ahead — the honest ledger

Supabase is a **mature, shipping product** with years of production usage; HoBo is **design-phase**. The sharpest concrete instance: Supabase ships **Realtime Presence** as a first-class feature, while HoBo has only *designed* presence as a **composition** of `websocket` rooms + the reactor + the new ephemeral `cache` port + an opt-in `@hobo/presence` package ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)) — no code yet. Supabase's **Postgres depth, integrated DX, `pgvector` toolkit, and ecosystem** are real, shipped advantages; HoBo's parity claims are **architectural intent**, Supabase's are **running software**. HoBo's bet is **breadth + governance + AI-native depth + cross-cloud portability** — and, tellingly, HoBo **need not out-Postgres Supabase**: it can **target Supabase as one provider** and add the meta-cloud layer around it.

### The one-line takeaway

**Supabase proves the open-source Postgres-BaaS model at scale** — Auth, RLS, Realtime (incl. **shipping Presence**), Storage, Edge Functions, and `pgvector` on a portable Postgres — and even ships collaboration primitives HoBo has only just designed ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)). HoBo's differentiation is **everything around a single backend**: cloud-agnostic ports + pluggable IaC, multi-paradigm data, an event-sourced governed control plane, agents-as-principals + a generation pipeline, cross-cloud portability, multi-tenant-app primitives, and self-host = hosted parity — **with the option to consume Supabase itself as one provider among many.**

## Better-together / integration posture

- **Provider-target** — a first-class realization behind HoBo's data, auth and storage ports.
- **Borrow** — **authorization expressed as data-layer policy**. RLS's property that policy applies
  regardless of access path is exactly what HoBo's policy layer should aspire to at its own
  boundaries.
- **Benchmark** on schema-to-working-API time.
- Not an adopt or displace target.

## Threats and lessons

1. **Standard Postgres is the strongest portability story in this corpus** — better than any
   abstraction, because it needs none. A useful reminder that adopting a standard can beat
   abstracting over several.
2. **Policy that travels with the data** is stronger than policy enforced at a gateway, and worth
   examining for HoBo's own contract boundaries.
3. **Change streams are not live queries.** The distinction between "rows changed" and "your answer
   changed" is the whole gap Convex fills, and it is worth being precise about.

## Sources

- [supabase.com/docs](https://supabase.com/docs) — Postgres, RLS, PostgREST, Auth, Realtime, Storage, Edge Functions, pgvector
- [supabase/supabase](https://github.com/supabase/supabase) — source and licensing

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Self-hosting parity and current service maturity were not re-verified in
this pass and are not asserted.
