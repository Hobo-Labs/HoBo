---
type: Competitive Reference
title: "Convex — Competitor Reference"
description: "Reactive TypeScript backend platform: a deterministic query reactor tracks each query's read set and pushes new results to every subscribed client."
tags: [hobo, competitors]
competitor:
  slug: convex
  name: "Convex"
  primary_category: backend-data-platforms
  categories: [backend-data-platforms]
  directness: adjacent
  role: "reactive TypeScript backend-as-a-service — source of the live-query gap and a possible provider target"
  posture: [borrow, provider-target]
  hobo_surface: [typed-contracts, wiring, runtime-portability]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.convex.dev/
    - https://github.com/get-convex/convex-backend
---

# Convex — Competitor Reference

> Captured for HoBo competitive analysis (research as of 2026, from docs.convex.dev / convex.dev / get-convex GitHub). A deep capture of Convex's developer surface — database, functions, sync, deployment, codegen, and the management plane — reproduced as factual API/CLI/config excerpts under the [fair-use note](index.md#sources--fair-use). HoBo↔Convex parity in [primitive mapping](#primitive-mapping).

## What it is

**Convex** is a **reactive, TypeScript-first backend platform** — *"the backend building blocks for your apps and agents."* You express the whole backend in pure TypeScript — **database**, schema, server **functions**, auth, scheduling, search — and Convex keeps frontend ↔ backend ↔ database **in sync in real time**. Three pillars carry the whole model:

- **Database** — an ACID document store with schemas, indexes, vector search, and file storage.
- **Functions** — server-side TypeScript: reactive **queries**, transactional **mutations**, side-effecting **actions**, HTTP actions, crons.
- **Sync** — automatic real-time subscriptions, so every client sees a consistent snapshot.

The core idea is the **deterministic query reactor**. Queries must be deterministic (same inputs → same outputs); the database tracks each query's read dependencies, and when any of that data changes the query **re-runs** and all subscribed clients are pushed the new result **simultaneously** — no manual cache invalidation, no hand-rolled WebSockets.

| Dimension | Convex |
|---|---|
| Category | Reactive backend-as-a-service (DB + functions + sync) |
| Language | **TypeScript** end-to-end (codegen'd types) |
| Database | Document model, **schemas + indexes**, **OCC serializable** transactions |
| Functions | queries (reactive) · mutations (txn) · actions (external; Convex/Node runtime) · HTTP actions |
| Realtime | automatic subscriptions; consistent snapshots; optimistic updates |
| Extras | scheduled fns + cron, file storage, **full-text + vector search**, components |
| Deploy | `npx convex deploy`, deploy keys, dev/prod/preview, CI/Vercel/Netlify |
| Codegen | `convex/_generated/` `api`/`server`/`dataModel` |
| Programmatic | **Management API** `api.convex.dev/v1` + OAuth apps + HTTP API |
| Hosting | Convex Cloud (Free/Pro/Enterprise) **or self-host** (Rust, FSL license) |
| Clients | React, Next.js, Vue, Svelte, Python, Rust, iOS, Android, Node |

Convex is **adjacent** to HoBo, not a head-on competitor: it's the kind of backend HoBo could *target as a capability provider*, and a sharp reference point for HoBo's generated clients and control-plane/provisioning APIs. Its known boundaries (vs HoBo's scope) frame the rest of this capture — a TS/JS-centric runtime and document model only (no relational SQL, no multi-model); a single-vendor backend (Convex Cloud or self-host), not a multi-cloud / IaC / control-plane story; hard per-call ceilings (1 s queries/mutations, 10-min actions, 1 MiB docs); and a **Beta** Management/Platform API with some endpoints documented only in the OpenAPI spec. See [primitive mapping](#primitive-mapping).

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Document / table** | The data model, with a typed schema in TypeScript |
| **Query** | A read function that is **reactive**: the client re-runs it automatically when anything it read changes |
| **Mutation** | A transactional write function |
| **Action** | A function permitted to call the outside world, outside the transaction |
| **Scheduler / cron** | Durable scheduled execution |
| **File storage / vector search** | Built-in adjacent capabilities |

The mental model is **the database tells you when your answer changed**. Convex tracks what each
query read and invalidates precisely; the developer writes a query and gets live data without
subscriptions, cache keys or invalidation logic. This is the capability HoBo's gap analysis has
recorded as the standout finding of the whole corpus.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `typed-contracts` | End-to-end TypeScript types from schema to client |
| `wiring` | Queries and mutations are the interface; no API layer to write |
| `runtime-portability` | Convex is one hosted runtime, with an open-source backend |

Convex is **adjacent, not head-on**: it is a backend platform, not a control plane. Its importance to
HoBo is that it demonstrates a data model HoBo's CQRS and materialized views do not currently match
in ergonomics.

## Feature surface

### Database

Documents are JSON-like objects (nested arrays/objects allowed); tables spring into existence on first insert. Every document gets two **system fields** (auto-managed, immutable): `_id: Id<"tableName">` (unique id) and `_creationTime: number` (ms since epoch).

Schema lives in `convex/schema.ts`:

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    body: v.string(),
    user: v.id("users"),
    channel: v.id("channels"),
  })
    .index("by_channel", ["channel"])
    .index("by_channel_user", ["channel", "user"]),
  users: defineTable({
    name: v.string(),
    tokenIdentifier: v.string(),
  }).index("by_token", ["tokenIdentifier"]),
  channels: defineTable({ name: v.string() }),
});
```

**Validators (`v.*`):** `v.string()`, `v.number()`, `v.boolean()`, `v.null()`, `v.int64()` (BigInt), `v.bytes()` (ArrayBuffer), `v.id("table")`, `v.array(...)`, `v.object({...})`, `v.record(k, v)`, `v.optional(...)`, `v.union(...)`, `v.literal(...)`, `v.any()`. Schema validation is **enforced by default** (disable per-table with `schemaValidation: false`); TypeScript types are **inferred** from validators, and `Infer<typeof v>` extracts a type.

**Indexes** are walked in field order:

```typescript
const recent = await ctx.db
  .query("messages")
  .withIndex("by_channel", (q) =>
    q.eq("channel", channel)
     .gt("_creationTime", Date.now() - 2 * 60000)
     .lt("_creationTime", Date.now() - 60000))
  .collect();
```

Range rules: zero+ `.eq()` equalities, then an optional lower bound (`.gt`/`.gte`), then an optional upper bound (`.lt`/`.lte`). Results sort by index order with `_creationTime` as tiebreaker. Limits: **16 fields/index**, **32 indexes/table**; staged indexes avoid blocking deploys on big tables.

**Reading.** `ctx.db.get(id)` → document | null. `ctx.db.query("table")` is chainable — `.withIndex(...)`, `.filter(q => …)`, `.order("asc"|"desc")` (default asc by `_creationTime`) — then a terminator: `.collect()` / `.take(n)` / `.first()` / `.unique()` / `.paginate(opts)`. Joins/aggregations/group-by are done in **JavaScript** (`Promise.all` for parallel lookups), not SQL; always bound unindexed scans with `.take`/`.first`/`.unique`/`.paginate`.

**Writing** (all inside a transaction): `ctx.db.insert("table", doc)` → new `Id`; `ctx.db.patch(id, partial)` (shallow merge — set a field `undefined` to remove it); `ctx.db.replace(id, doc)` (full replace); `ctx.db.delete(id)`. A **mutation is one transaction** — all writes commit atomically when it returns.

**Transactions** use **Optimistic Concurrency Control** (no locks): assume conflicts are rare, verify read/write sets at commit, **auto-retry** on conflict. Isolation is **serializable** — you never read inconsistent data. Rapid writes to the same document can surface OCC conflict errors (mitigate with sharding/components).

**Pagination** is cursor-based:

```typescript
import { paginationOptsValidator } from "convex/server";
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) =>
    ctx.db.query("messages").order("desc").paginate(args.paginationOpts),
});
```

In React, `const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 5 })` — status ∈ `LoadingFirstPage|CanLoadMore|LoadingMore|Exhausted`; pages stay **reactive** and resize as data changes.

**Key limits:** 1 MiB/document, 1,024 fields/doc, 16 nesting levels, 8,192 array elements; 10,000 tables/deployment; per-transaction 32,000 docs scanned, 16,000 written, 16 MiB read & 16 MiB written, 4,096 index ranges. (Full table under [Self-hosting, pricing & limits](#self-hosting-pricing--limits).)

### Functions

Functions are defined with builders from [generated code](#generated-code-convex_generated). There are three kinds:

| Kind | Reads DB | Writes DB | External calls | Reactive/cached | Transactional |
|---|---|---|---|---|---|
| **query** | ✅ | ✗ | ✗ | ✅ (subscribable) | ✅ (read txn) |
| **mutation** | ✅ | ✅ | ✗ | ✗ | ✅ (atomic) |
| **action** | via `runQuery`/`runMutation` | via `runMutation` | ✅ (`fetch`) | ✗ | ✗ |

- **Queries** are **deterministic** and **reactive** — auto-cached, auto-subscribed; re-run and pushed when their read-set changes.
- **Mutations** are **transactions** (OCC, all-or-nothing); no external calls.
- **Actions** are "normal serverless functions" for side effects (OpenAI/Stripe/Twilio…); no direct DB, no caching/reactivity, not auto-retried. Keep them small; coordinate via the scheduler.

```typescript
import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";

export const listChannel = query({
  args: { channel: v.id("channels") },
  returns: v.array(v.object({ _id: v.id("messages"), body: v.string() })),
  handler: async (ctx, args) =>
    ctx.db.query("messages").withIndex("by_channel", q => q.eq("channel", args.channel)).collect(),
});

export const send = mutation({
  args: { channel: v.id("channels"), body: v.string() },
  handler: async (ctx, args) => { await ctx.db.insert("messages", args); },
});

export const summarize = action({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const res = await fetch("https://api.openai.com/…", { /* … */ });
    const summary = (await res.json()).summary;
    await ctx.runMutation(internal.messages.saveSummary, { summary });
  },
});
```

**Internal functions** — `internalQuery` / `internalMutation` / `internalAction` — are callable only from other functions (actions, HTTP actions, scheduled/cron jobs, dashboard, CLI), never directly from clients. Use them to shrink public surface area (e.g. charge a card in a public action, then call an `internalMutation` to update the user's plan).

**HTTP actions** (`convex/http.ts`) build an HTTP API at `https://<deployment>.convex.site`:

```typescript
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();
http.route({
  path: "/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    await ctx.runMutation(internal.events.record, { body });
    return new Response(null, { status: 200 });
  }),
});
export default http;
```

Route by `path` (exact) or `pathPrefix` (dynamic); standard `Request`→`Response`; call `ctx.runQuery/runMutation/runAction`. No built-in body validation (parse manually). Good for webhooks.

**Validators.** Each function takes `{ args, handler, returns? }`; `args`/`returns` use the `v.*` validators above. Args are typed automatically and **extra properties are rejected**; return validators enforce the output shape.

**The `ctx` surface** varies by kind:

- **`QueryCtx`** — `db` (read), `auth`, `storage` (read).
- **`MutationCtx`** — `db` (read/write), `auth`, `storage`, `scheduler`, `vectorSearch`.
- **`ActionCtx`** — `runQuery` / `runMutation` / `runAction`, `auth`, `scheduler`, `storage`, `vectorSearch` (no direct `db`).
- `ctx.auth.getUserIdentity()` → the verified caller identity or null (see [Auth, integrations & ops](#auth-integrations--ops)).

**Runtimes.** The **Convex runtime** (default) is V8-based, Cloudflare-Workers-like, with **no cold starts** and web-standard globals (`fetch`, `Blob`, Web Crypto, Web Streams) plus limited Node APIs (`process.env`); all queries/mutations run here and must be deterministic. The **Node.js runtime** is opt-in with `"use node";` at the top of a file, is **actions only**, gives full npm/Node libs (Node 20/22/24), has a 5 MiB arg limit (vs 16 MiB), and may cold-start.

**Error handling** has four categories: **application** (`throw new ConvexError(data)` for expected failures — custom data survives to prod), **developer** (bugs), **read/write limit**, and **internal** (auto-retried). Query errors throw from `useQuery` (use a React error boundary), and retrying is pointless (deterministic). Mutation rejections roll back optimistic updates. Actions aren't auto-retried — the caller handles retries. Dev shows full messages/stacks; prod shows only the function name + a generic "Server Error" (except `ConvexError` data).

### Scheduling, search & storage

**Scheduled functions** (`ctx.scheduler`) run a function once in the future, durably (stored in the DB, survives restarts), from a mutation or action:

```typescript
await ctx.scheduler.runAfter(5000, internal.messages.destruct, { messageId: id }); // ms delay
await ctx.scheduler.runAt(targetEpochMs, internal.billing.charge, { userId });      // absolute time
```

Returns the scheduled function id (for status/cancel); schedule minutes→months out. Limits: ≤1000 functions scheduled per call; 4 MiB per scheduled-arg payload, 16 MiB total per mutation; up to 1,000,000 outstanding scheduled functions.

**Cron jobs** (`convex/crons.ts`):

```typescript
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("rotate", { minutes: 1 }, internal.jobs.rotate);
crons.cron("cleanup", "0 16 1 * *", internal.jobs.cleanup);   // 5-field, UTC
crons.hourly("sync", { minuteUTC: 0 }, internal.jobs.sync);
crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, internal.jobs.digest);
crons.weekly(/* … */); crons.monthly(/* … */);
export default crons;
```

Targets are mutations or actions. At most one run of a given cron executes at a time; long runs may cause skips. Crons are static (defined at deploy); a Convex component offers dynamic create/update/delete crons.

**File storage** uses a three-step upload for large files: generate a short-lived upload URL in a mutation → client `POST`s the file → save the returned `storageId`.

```typescript
export const generateUploadUrl = mutation({
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});
// client:
const url = await generateUploadUrl();
const { storageId } = await (await fetch(url, { method: "POST",
  headers: { "Content-Type": file.type }, body: file })).json();
await sendImage({ storageId });
```

Serve with `ctx.storage.getUrl(storageId)`. Download in an action via `ctx.storage.get(id)` → `Blob`; store a blob with `ctx.storage.store(blob)` → id (HTTP-action store is ≤20 MiB). Delete with `ctx.storage.delete(id)`. Metadata lives in the `_storage` system table — query it with `ctx.db.system.get("_storage", id)` (fields: `sha256`, `size`, `contentType`, `_id`, `_creationTime`).

**Full-text search** is reactive keyword/phrase search with **prefix matching** (typeahead) that stays live with your data. Limits: 4 search indexes/table, ≤1,024 results.

**Vector search** (`ctx.vectorSearch`, actions only):

```typescript
export const similar = action({
  args: { query: v.string() },
  handler: async (ctx, args) => {
    const embedding = await embed(args.query);      // external embedding API
    return ctx.vectorSearch("foods", "by_embedding", {
      vector: embedding, limit: 16, filter: q => q.eq("cuisine", "French"),
    }); // → [{ _id, _score }] ranked by cosine similarity
  },
});
```

Define a vector index in the schema (field + `dimensions` + optional filter fields). Limits: 4 vector indexes/table, ≤256 results, dimensions 2–4,096. **Hybrid search** (text + vector via reciprocal rank fusion) is supported by combining the two.

### Reactivity, clients & components

The Convex DB is reactive: whenever data a query depends on changes, the query re-runs and **client subscriptions update**. The guarantees are **consistent snapshots** — *"every client subscription gets updated simultaneously to the same snapshot of the database"*, so you never observe a torn/partial state — and **automatic caching** (query results cached, invalidated on dependency change). This solves classic bugs (stale "in stock" counts, etc.) without manual cache or WebSocket code. Transport: the reactive clients hold a **persistent WebSocket** for 2-way push; queries/mutations over plain HTTP are also possible (see [Management, platform & HTTP APIs](#management-platform--http-apis)).

The **React client**:

```typescript
const data = useQuery(api.messages.list, { channel });   // undefined while loading; reactive after
const send = useMutation(api.messages.send);             // async fn; supports optimistic updates + retries
const run  = useAction(api.ai.summarize);                // async fn; no auto-retry/optimistic
await send({ channel, body: "hi" });
```

`useQuery` subscribes (and unsubscribes on unmount) and keeps multiple queries mutually consistent per render. **Optimistic updates** — `useMutation(api.x).withOptimisticUpdate((store, args) => { … })` — update local query results instantly, rolled back on failure. `Authenticated` / `Unauthenticated` / `AuthLoading` components plus `useConvexAuth()` gate on auth state.

**Other clients.** `ConvexReactClient` is the React/WebSocket client (set up via `ConvexProvider`). `ConvexClient` is the reactive client for Node/JS (`client.onUpdate(api.fn, args, cb)`, `client.mutation(...)`). `ConvexHttpClient` does one-shot `query`/`mutation`/`action` over HTTP (SSR, scripts, serverless, migrations). Framework coverage spans Next.js (incl. server rendering / preloading via provider SDKs), Vue (`convex-vue`)/Nuxt, Svelte (`convex-svelte`), Python, Rust, React Native, iOS (Swift), Android (Kotlin), Remix, TanStack Start, Bun, and a script tag; a `@convex-dev/react-query` adapter bridges TanStack Query, and `anyApi` gives untyped function access when functions aren't co-located with the client.

**Components** are reusable backend modules — *"mini self-contained Convex backends"*: bundled functions + schema + persistent state, distributed as npm packages or local modules.

- **Isolation/sandboxing:** a component has its **own tables + functions**; it **cannot** read your app's data/functions, and your app **cannot** mutate its data, unless explicitly wired. *"Installing them is always safe."*
- **Transactional across boundaries:** calls between app and component participate in the same consistency model, with runtime validation on all data crossing the boundary.
- **Mount** in `convex/convex.config.ts`:
  ```typescript
  import { defineApp } from "convex/server";
  import rateLimiter from "@convex-dev/rate-limiter/convex.config";
  const app = defineApp();
  app.use(rateLimiter);
  export default app;
  ```
- **Constraints:** no `ctx.auth` inside a component (pass the user id as an arg); `Id<"table">` appears as a string across the `ComponentApi`; no built-in pagination (use `paginator` from `convex-helpers`).
- **Examples:** sharded counters, workflows, leaderboards, rate limiters, persistent text streaming, agents.

### Generated code (`convex/_generated/`)

Convex derives, from your schema (`schema.ts`) and function modules, a set of files under `convex/_generated/` that give the **backend** correctly-typed function builders + `ctx` types and give **callers** (client and server) **type-safe references** to every function — so `useQuery(api.messages.list, args)` is checked end-to-end (arg types and return types) at compile time. The generated files track the current module tree + schema, so commit code before relying on the types. Regeneration is automatic via `npx convex dev` (watches and regenerates on every save, then pushes), on demand via `npx convex codegen` (regenerates without pushing), and as part of `npx convex deploy`. Net effect: renaming a function or changing a validator surfaces as a **compile error** at every call site.

**`api.js` / `api.d.ts` — function references.** Exports two objects whose nested shape **mirrors the `convex/` directory**: `api` (references to all **public** functions — a function exported from `convex/messages.ts` as `list` is `api.messages.list`; nested dirs nest, e.g. `api.admin.users.ban`) and `internal` (the same structure for **internal** functions). Each leaf is a typed **`FunctionReference`** carrying the function's arg + return types, used as a *handle*, never imported directly:

```typescript
// React
const msgs = useQuery(api.messages.list, { channel });
// server (action / scheduler / cron)
await ctx.runQuery(api.helpers.getData, { id });
await ctx.scheduler.runAfter(0, internal.jobs.process, { id });
```

(For clients not co-located with the backend, `anyApi` gives untyped references.)

**`server.js` / `server.d.ts` — builders + ctx types,** pre-bound to your schema/data model. Exports the **function constructors** `query`, `mutation`, `action`, `internalQuery`, `internalMutation`, `internalAction`, `httpAction`, plus the schema-aware context **types** (`QueryCtx`, `MutationCtx`, `ActionCtx`, as detailed under [Functions](#functions)):

```typescript
import { query, mutation, internalMutation, httpAction } from "./_generated/server";
```

**`dataModel.d.ts` — schema-derived types,** generated from `schema.ts`: a `Doc<"table">` document type and an `Id<"table">` id type per table, plus a `DataModel` type that parameterizes `ctx.db`. This is what makes `ctx.db.get(id)` and query results strongly typed.

For apps using/authoring components, codegen also emits component API typings (`component.d.ts` / `api_cm.js`) describing the mounted component's `ComponentApi` (with `Id<"table">` surfaced as `string` across the boundary).

### CLI & deployment

Install with `npm install convex`. The `npx convex` CLI spans develop, deploy, run/data, env/ops, and deployment/auth:

**Develop** — `npx convex dev` watches files → regenerates `convex/_generated/` → pushes code to your **dev** deployment (creating `.env.local` with dev creds on first run; flags `--once`, `--run <fn>`, `--tail-logs always|pause-on-deploy|disable`, `--until-success`). `npx convex codegen` regenerates generated files without pushing (`--init`, `--typecheck`). `npx convex dashboard` / `npx convex docs` open the dashboard / docs.

**Deploy** — `npx convex deploy` typechecks, regenerates, bundles, and **pushes to production** (or a preview). Flags: `--cmd 'npm run build'` (runs the frontend build with `CONVEX_URL` injected), `--cmd-url-env-var-name VITE_CONVEX_URL`, `--preview-create <name>`, `--preview-run <fn>`, `--message '…'`, `--dry-run`. Non-interactive in CI via `CONVEX_DEPLOY_KEY`.

**Run / data** — `npx convex run <module:fn> '<jsonArgs>'` executes any function (`--watch`, `--push`, `--prod`, `--component`, `--inline-query 'await ctx.db.query("messages").take(5)'`). `npx convex data [table]` lists tables / browses rows (`--limit`, `--order`). `npx convex import [--table <t>] <file|zip>` / `npx convex export --path <dir|zip> [--include-file-storage] [--prod]` move data.

**Env / ops** — `npx convex env list|get|set|remove` (`--from-file`, `--prod`; limits: name ≤256 chars, value ≤8 KiB, ≤512 vars, ≤512 KiB total). `npx convex logs [--prod]`, `npx convex insights [--details] [--prod]` (concurrency conflicts / limit hits over ~72 h), `npx convex function-spec` (function arg/return metadata).

**Deployment / auth** — `npx convex deployment select|create|token …` (keys below). `npx convex login [--name] [--force]`, `npx convex login status`, `npx convex logout`. `npx convex update`, `npx convex mcp` (Beta, MCP server), `npx convex ai-files` (AI helper files).

**Deployment model.** Each project has **one shared production** deployment + **one dev deployment per team member**, plus **preview** deployments for feature branches; deployments in a project usually run the same codebase. The **deployment URL** is `https://<adjective>-<animal>-<number>.convex.cloud` (e.g. `https://acoustic-panther-728.convex.cloud`); the HTTP-actions host is `…convex.site`. **Key env vars:** `CONVEX_DEPLOYMENT` (selects the default deployment in local dev), `CONVEX_URL`/`VITE_CONVEX_URL` (frontend → backend; set by `deploy`), `CONVEX_DEPLOY_KEY` (non-interactive CI deploys), `CONVEX_SELF_HOSTED_URL`/`CONVEX_SELF_HOSTED_ADMIN_KEY` (self-host).

**Deploy keys** come in a taxonomy:

| Type | Format (prefix) | Scope |
|---|---|---|
| Production deploy | `prod:<name>\|…` | deploy code to one prod deployment |
| Preview deploy | `preview:<team>:<project>\|…` | deploy to preview deployments |
| Project token | `project:<team>:<project>\|…` | whole project (create prod+dev) |
| Development deploy | `dev:<name>\|…` | one dev deployment (e.g. scoped agent work) |
| Admin key | `<name>\|…` | full deployment control (offline/self-host) |

Manage via `npx convex deployment token create <name> [--prod] [--deployment <ref>] [--save-env .env.local]` / `… token delete <nameOrToken>`. (There is no `deployment token list` command — track issued keys yourself.)

**CI / Vercel / Netlify.** Set `CONVEX_DEPLOY_KEY` in the build env, then make the build command:

```bash
npx convex deploy --cmd 'npm run build'
# custom frontend var name:
npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL
```

`deploy` pushes the backend, sets `CONVEX_URL` for the build, then runs your build. Preview deployments use a **preview** deploy key + `--preview-create`/`--preview-run`; the Vercel marketplace integration syncs the deploy key automatically and supports separate Production/Preview configs.

### Management, platform & HTTP APIs

Convex exposes three programmatic surfaces plus an OAuth flow. **The Management/Platform API is Beta** — the authoritative shape is the published OpenAPI spec, and some endpoints are documented only there; contact `platforms@convex.dev` for capabilities beyond the beta. Treat the Management/Platform API as **moving** — generate clients from the OpenAPI spec rather than hard-coding.

**1) Management API — provision teams/projects/deployments.** Base `https://api.convex.dev/v1`; auth `Authorization: Bearer <token>`, where the token is either a **Team Access Token** (manage your own team) or an **OAuth Application Token** (act on behalf of a user's team — how a third-party integration provisions Convex for users). Spec/client: OpenAPI at `https://api.convex.dev/v1/openapi.json`; official client `@convex-dev/platform` (npm). Representative endpoints (full list in the spec):

- `GET  /projects/:project_id/list_deployments`
- `POST /projects/:project_id/create_deployment`
- `GET  /deployments/:deployment_name/list_deploy_keys`
- `POST /deployments/:deployment_name/create_deploy_key`
- project creation/management, deploy-key management, team-level ops.

Capabilities: create/configure projects + deployments, mint/revoke deploy keys, manage env vars, programmatic provisioning of Convex infra.

**2) Deployment Platform API — configure a single deployment.** Auth: an admin-scoped key with the **`Convex ` prefix**: `Authorization: Convex <access_key>` (accepts deploy keys, team-access tokens, or OAuth app tokens). Purpose: modify a deployment's configuration (e.g. environment variables — `list_environment_variables`, etc.). Status: openly available in **Beta**; not all endpoints are publicly documented.

**3) Client HTTP API — call functions over HTTP.** Base `<CONVEX_URL>/api/...`; endpoints `POST /api/query`, `POST /api/mutation`, `POST /api/action`, and `POST /api/run/{functionIdentifier}`. Request `{ "path": "module:function", "args": { … }, "format": "json" }` (the `/api/run/...` form omits `path`). Response: success `{ "status": "success", "value": …, "logLines": [...] }`; error `{ "status": "error", "errorMessage": …, "errorData": …, "logLines": [...] }`. Auth: end-user calls use `Authorization: Bearer <id_token>` (from your auth provider); admin/streaming use `Authorization: Convex <access_key>`. Only `json` format today; real-time subscriptions use the WebSocket client, not this HTTP API.

**4) OAuth applications (third-party integrations).** Register in Dashboard → Team Settings → Applications → OAuth Apps (up to 20 redirect URIs incl. localhost; apps start "Unverified" — token issuance is limited to your own team until verified). Standard **OAuth 2.0 Authorization Code flow (+ PKCE, S256)**:

1. **Authorize:** redirect to `https://dashboard.convex.dev/oauth/authorize/team` (or `/project`) with `client_id`, `redirect_uri`, `state`, `response_type=code`.
2. **Callback:** `<redirect_uri>?code=…&state=…`.
3. **Token:** `POST https://api.convex.dev/oauth/token` with `{ client_id, client_secret, code, grant_type: "authorization_code" }` (+ PKCE `code_verifier`) → `{ "access_token": "…", "token_type": "Bearer" }`.

Token scopes are *team-scoped* (create projects/deployments, access/modify data across the team's projects) or *project-scoped* (create deployments + manage data within one project); all tokens inherit the authorizing member's permissions.

### Auth, integrations & ops

Convex validates tokens backend-side via `convex/auth.config.ts` and exposes the verified caller as `ctx.auth.getUserIdentity()`. Auth providers:

- **Convex Auth** — auth library running *on your Convex backend* (no external service): magic links/OTP, OAuth (GitHub/Google/Apple/80+), email+password (reset + optional verification), custom OIDC, custom JWT. Beta; ships no UI components (`labs.convex.dev/auth`).
- **Clerk** — `<ConvexProviderWithClerk>`; `auth.config.ts` `{ domain: CLERK_JWT_ISSUER_DOMAIN, applicationID: "convex" }`.
- **Auth0** — `<ConvexProviderWithAuth0>`; `auth.config.ts` `{ domain, applicationID }`.
- **Custom OIDC** — any OpenID Connect issuer; `applicationID` must equal the JWT `aud` and `domain` must equal `iss`.
- **`customJwt`** — for issuers whose tokens may lack `aud`; configure `{ type: "customJwt", issuer, jwks, algorithm }`. **This is the hook [shoo.dev](shoo.md#convex-integration) plugs into** (issuer `https://shoo.dev`, ES256, JWKS).

**Log streams (Pro)** stream function executions, console logs, audit logs, and scheduler/concurrency/storage stats to **Axiom** (dataset + API key; auto dashboards), **Datadog** (site + API key + `ddtags`), **PostHog** (project token, OTLP), or a **custom webhook** (JSON event array; HMAC-SHA256 signature in `x-webhook-signature`, validate with constant-time compare + timestamp check). **Exception reporting (Pro)** covers **Sentry** (captures function name/type/runtime/deployment/request-id/user identity), **PostHog Error Tracking** (+ stack traces), and **Datadog Error Tracking** (via Sentry SDK).

The **dashboard** offers function logs (timestamps + exec time), a data explorer (browse/edit/filter), performance metrics (cache-hit/failure rates, scheduler lag), call-frequency graphs, health/insights (concurrency + limit hits), a Schedules page (scheduled fns + crons), and direct run/test of functions; open it with `npx convex dashboard`.

**Import / export & streaming (Beta).** Import CSV/JSON into a single table via CLI, restore from a backup zip, or **streaming import** via an **Airbyte** destination connector. Export a snapshot zip (dashboard or `npx convex export`) or **streaming export** via **Fivetran** to a warehouse. CLI: `npx convex import [--table <t>] <file|zip>`, `npx convex export --path <dir|zip> [--include-file-storage] [--prod]`. The Airbyte/Fivetran connector details are referenced but lightly documented.

**`convex-helpers`** is a companion npm package: custom functions, relationship helpers, stateful migrations, an action-retry wrapper, rate limiting, sessions, row-level security, Zod validation, Hono HTTP, CRUD, query streaming + manual `paginator`, query caching, CORS for `HttpRouter`, an OpenAPI/TS-API generator, triggers, and Standard Schema support.

### Self-hosting, pricing & limits

Convex's backend is **open source** — `github.com/get-convex/convex-backend` (≈44% Rust / ≈44% TypeScript; `crates/` = Rust server incl. `local_backend/`, `npm-packages/` = TS):

```bash
docker compose up                                   # backend + dashboard
docker compose exec backend ./generate_admin_key.sh # admin credentials
```

Endpoints: dashboard `http://localhost:6791`, backend `http://127.0.0.1:3210`, HTTP actions `http://127.0.0.1:3211`. Wire the CLI to it via `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` in `.env.local`, then `npx convex dev`/`deploy` as usual. DB backends: SQLite by default (Docker volume); **Postgres/MySQL** for production (Neon, AWS RDS, etc.); S3 for export/snapshot storage; Fly.io / Railway configs provided. **License:** **FSL-1.1-Apache-2.0** — *"almost anything Apache-2.0 allows, except create another product designed to compete with Convex Cloud"* — which **converts to full Apache-2.0 after 2 years**.

Convex Cloud editions:

| Plan | Highlights |
|---|---|
| **Free / Starter** | 1M function calls/mo, 0.5 GB storage, hard caps, self-service, Discord support |
| **Professional** ($25/developer/mo) | 50 GB storage, 50 GB DB I/O, 50 GB egress, 250M calls/mo; log streams + exception reporting; per-seat + discounted usage-based |
| **Enterprise** | advanced telemetry/compliance, SSO, auditing, SLAs, custom pricing |

*(Startup program: up to 1 yr free Pro + usage discounts.)* Concurrency classes set the SLA tiers:

| Class | Concurrent queries | Concurrent actions | Sessions |
|---|---|---|---|
| **S16** (free) | 16 | 64 | 1,000 |
| **S256** (pro) | 256 | 256 | 10,000 |
| **D1024** (enterprise/scale) | 1,024 | 1,024 | 100,000 |

Selected hard limits:

| Limit | Value |
|---|---|
| Document size | 1 MiB |
| Fields per document | 1,024 |
| Field nesting depth | 16 |
| Tables per deployment | 10,000 |
| Indexes per table / fields per index | 32 / 16 |
| Search & vector indexes per table | 4 each |
| Query / mutation execution time | **1 second** |
| Action execution time | **10 minutes** |
| Function arg / return size | 16 MiB (5 MiB for Node actions) / 16 MiB |
| HTTP action response | 20 MiB |
| Docs scanned / written per transaction | 32,000 / 16,000 |
| Data read / written per transaction | 16 MiB / 16 MiB |
| Outstanding scheduled functions | 1,000,000 |
| Env vars | ≤512 vars, ≤8 KiB each, ≤512 KiB total |

These per-call ceilings (1 s queries, 10-min actions, 1 MiB docs) shape the architecture: keep functions small, and push heavy/long work into actions + scheduled functions + components.

## Architecture

- **Reactive query engine** — the core: each query's read set is tracked, so a write invalidates
  exactly the queries it affects and clients receive updates without polling.
- **Transactional mutations** run against a consistent snapshot; actions are the escape hatch for
  non-transactional side effects, which keeps the transactional core clean.
- **Deployment** — hosted Convex, with an open-source backend for self-hosting.
- **State authority** — Convex's own store, which is the system of record for applications built on
  it.
- **Portability boundary** — the programming model *is* the platform. Queries, mutations and the
  reactivity contract are Convex's; an application built this way is built on Convex.

## Where Convex is stronger

> Shipped, evidenced capability only.


What's genuinely strong:

1. **Reactive by default** — the deterministic query reactor: queries auto-subscribe and re-run on dependency change; all clients get the **same consistent snapshot** simultaneously, with no cache-invalidation or WebSocket plumbing.
2. **End-to-end TypeScript + codegen** — DB schema, functions, validators, and **typed function references** (`convex/_generated/`) make calls compile-checked from client to DB; renames/validator changes break at call sites.
3. **Serializable OCC transactions** — mutations are atomic; no locks; auto-retry on conflict.
4. **Batteries included** — scheduled functions + cron, file storage, full-text + **vector search**, HTTP actions, and auth in one backend.
5. **Components** — sandboxed, transactional, reusable backend modules (rate limiters, workflows, agents…).
6. **AI-friendly** — typed, SQL-less, low-boilerplate code that LLMs generate reliably; MCP server + agent skills.
7. **Programmable platform** — Management API + OAuth apps + deploy keys let third parties provision/operate Convex for users.
8. **OSS self-host** — full backend (Rust) under FSL→Apache-2.0; no hard lock-in.

Gaps relative to HoBo's scope:

1. **TS/JS-centric** runtime; **document model only** (no SQL/relational/multi-model; joins/aggregations are hand-written JS).
2. **Single-vendor backend** — Convex Cloud or self-host; **not multi-cloud, not IaC, not a control plane** for *other* infra.
3. **Hard per-call ceilings** (1 s queries/mutations, 10-min actions, 1 MiB docs) shape (and constrain) architecture.
4. **No event-sourced replay/time-travel** of the whole system; reactivity ≠ an append-only audit log.
5. Management/Platform API is **Beta**; some surfaces documented only via OpenAPI.

Head-to-head:

| vs | Convex's edge | Their edge |
|---|---|---|
| **Firebase** | type-safe TS functions + real serializable transactions + reactive queries | bigger ecosystem, GCP integration, more mature mobile |
| **Supabase** | reactive-by-default + end-to-end TS + components | Postgres/SQL, relational power, broad SQL tooling |
| **Appwrite** | reactive queries + codegen + OCC transactions | self-host maturity, broader language SDKs |
| **PlanetScale / Neon** | full backend (functions/sync/auth), not just a DB | serverless SQL at scale, branching |
| **Aspire** ([../aspire](aspire.md)) | a *running managed backend* + reactivity | Aspire orchestrates *your* polyglot services to *your* infra (composition, not a hosted DB) |

## Primitive mapping

<a id="hobo-mapping"></a>

> For each Convex surface, the HoBo equivalent. ✅ = HoBo has a comparable concept · ➕ = HoBo goes further · ↔ = adjacent/composes · n/a = out of scope. HoBo design lives in [`../../design/`](../design/index.md). Convex is **adjacent** to HoBo — a managed reactive backend, not a multi-cloud control plane — so this tracks *conceptual* correspondences (and where Convex could be a HoBo provider), not feature-for-feature competition.

### Core platform

| Convex | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Deterministic reactive queries; consistent snapshots | Event-sourced, deterministic **replay** + projections; durable workflows | ↔➕ | [11](../design/data-plane.md#plan-11) |
| Mutations = OCC serializable transactions | Single-writer actor leases + exactly-once effects | ✅ | [05](../design/reliability-observability-cost.md#plan-05) |
| Actions (external calls; Node runtime) | Provider/driver calls in sandboxed Executors; durable `step`/`workflow` | ✅ | [02](../design/sdk-api.md#plan-02), [04](../design/control-plane.md#plan-04) |
| Document DB + schema + indexes + vector search | A **capability/resource** in HoBo's catalog (`database`/`vector`/`blobstore` ports) | ↔ | [21](../design/authoring-resources-wiring.md#plan-21), [24](../design/wasm-runtime-wit.md#plan-20) |
| Scheduled functions + cron | Saga scheduling + Pipelines/triggers | ✅ | [05](../design/reliability-observability-cost.md#plan-05), [28](../design/platform-engineering.md#plan-25) |
| HTTP actions / webhooks | Provider HTTP ports + GitOps/webhook triggers | ✅ | [22](../design/authoring-resources-wiring.md#plan-21), [28](../design/platform-engineering.md#plan-25) |

### The three user-emphasized surfaces

| Convex | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| **Generated code** (`_generated/` `api`/`server`/`dataModel`; typed function refs) | **WIT-interface-generated typed clients** + typed `.with(...)`; codegen from ports | ✅➕ | [02](../design/sdk-api.md#plan-02), [24](../design/wasm-runtime-wit.md#plan-20), [20](../design/wasm-runtime-wit.md#plan-20) |
| **Deployment API/model** (`convex deploy`, deploy keys, dev/prod/preview, CI) | The **Yard** deploy lifecycle: manifest/Set, Deltas→Sets, ephemeral/preview Camps, publishers | ✅➕ | [04](../design/control-plane.md#plan-04), [22](../design/authoring-resources-wiring.md#plan-21), [26](../design/platform-engineering.md#plan-25) |
| **Management/Platform API** (`api.convex.dev/v1`, OAuth apps, provision deployments) | The Yard's control-plane API + MCP + agents-as-OIDC-principals provisioning | ✅➕ | [04](../design/control-plane.md#plan-04), [06](../design/ai-native-agent-auth.md#plan-06) |

### Ops, extensibility & auth

| Convex | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Components (sandboxed reusable backends) | Capability providers + **Resource Packs** (signed, conformance-gated) | ✅➕ | [27](../design/platform-engineering.md#plan-25), [03](../design/control-plane.md#plan-04) |
| Log streams / exceptions / dashboard | Observability + run inspector + replay | ✅➕ | [14](../design/reliability-observability-cost.md#plan-05), [07](../design/developer-experience.md#plan-07) |
| Self-host (Rust backend; FSL→Apache) | Self-host = hosted (the Yard is a Bindle); OSS core | ✅ | [04](../design/control-plane.md#plan-04), [17](../design/vision.md#plan-17) |
| Auth: `customJwt`/OIDC (Convex Auth/Clerk/Auth0) | Workload/agent identity (SVIDs, OIDC principals); **shoo** composes via `customJwt` | ↔ | [06](../design/ai-native-agent-auth.md#plan-06), [12](../design/security-networking.md#plan-12), [../shoo](shoo.md) |
| AI: MCP server + agent skills | Agents-as-principals + MCP control surface + generation pipeline | ✅➕ | [06](../design/ai-native-agent-auth.md#plan-06), [23](../design/generated-stack.md#plan-23) |

### Convex-as-a-HoBo-provider (the composing relationship)

The cleanest framing: **Convex is a backend HoBo realizes as a capability provider** — now scaffolded as `@hobo/provider-convex` (`packages/providers/provider-convex`, thin adapter per [ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144)). A Bindle that declares `data`/`bucket`/`api` resources is mapped (via Resource Definitions, [Plan 25](../design/platform-engineering.md#plan-25)) to a Convex deployment: the provider's capability manifest advertises `database/reactive` (with `search.vector` and `functions.scheduled` as capability features), `objectStore`, and `web/service`; provisioning targets Convex's **Management API** behind a credential-gated, fail-closed client (deploy keys are broker-held — `staticSecrets: false`, wired via `secretRef`, never Bindle config); connection refs flow through the manifest ([Plan 21](../design/authoring-resources-wiring.md#plan-21)). In that framing Convex is *infrastructure HoBo orchestrates*, not a competitor. Note honestly: HoBo has **no `vector` port today** — vector search rides as a feature of the reactive-database capability until one lands.

### Examples — Swaghaus (WorkOS kept)

Live Examples catalog ships [JamesCowling/swaghaus](https://github.com/JamesCowling/swaghaus) (MIT) under `examples/convex-swaghaus/` via a provider-neutral Bindle:

- Authoring: `@hobo/convex` `convexApp(root)` on `b.web(...)` plus official `b.container({ image: "ghcr.io/get-convex/convex-backend:latest" })` and WorkOS AuthKit as `b.external` — Bindle never pins the `convex` provider ([ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144)); never invent `hobo/convex-*` images.
- Cloudflare Examples Yard: **anon Temporary Convex self-host is fail-closed** under zero project API keys (`@hobo/provider-convex` `provisionConvexBackendAnonymous` — Instanode: no anon containers; OpenPouch anon: 256MiB cgroup vs ~205MB `convex-local-backend`; CF Temporary Containers apply **403**). Mock via `HOBO_CONVEX_SWAGHAUS_MOCK=1`. Escapes: `HOBO_CONVEX_OCI_HOST=cloudflare`, `HOBO_CONVEX_ALLOW_CLOUD=1`. E2B/SnapDeploy credentialed paths stay **out of scope**. Frontend still Temporary Pages. Local Yard compose remains in `examples/convex-swaghaus/docker-compose.yml`.
- WorkOS client id/secrets ride Camp `secretRef` / external connector — **presence-gated, fail closed**. CI may set `HOBO_CONVEX_SWAGHAUS_MOCK=1`; no silent mock without that flag when Containers credentials are absent.
- Operator SDK adapters: `CONVEX_SDK_RESOURCES` (`defineResource` for reactive database + function-host).

### Impedance boundaries for the provider path

Realizing ports on Convex is deliberately **partial-fidelity**; these boundaries are scored by the PortabilityReport ([ADR-0024](../design/adr/07-portability-extensibility.md#adr-0024) — provider `.with()` blocks and paradigm mismatches are lock-in sources) so neither humans nor agents can over-claim:

- **Document model + JS joins vs multi-model.** Convex is a document store with code-side joins; HoBo's `paradigm` vocabulary marks it `document` — mapping a `relational`/`graph` expectation onto it is a recorded paradigm mismatch, not a silent adaptation.
- **Reactive consistent-snapshot queries vs event-sourced replay.** Convex's reactivity is live-query invalidation over current state; HoBo's substrate is an append-only log with full replay/time-travel ([Plan 11](../design/data-plane.md#plan-11)). Data and functions living inside Convex are **outside** HoBo's control-plane time-travel and cross-Yard Trails; only the provisioning lifecycle is event-sourced.
- **Hard runtime limits.** 1 s query/mutation execution, 1 MiB document size, 10 min actions, transaction size caps — encoded as typed constants in `@hobo/provider-convex` so planners and reviewers see them, not discover them.
- **OCC contention vs actor leases.** Convex mutations retry on optimistic-concurrency conflicts; HoBo actors serialize via leases/fencing. High-contention aggregates behave differently under load.
- **TS/JS runtime vs WIT polyglot.** Convex functions are TypeScript/JavaScript only; the WIT membrane ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) does not extend into Convex-hosted code.
- **Escape hatches are Yard-scoped.** Convex-specific options ride Camp/Yard `.with(...)` annotations (Bindles reject provider annotations by construction) and are marked non-portable in the PortabilityReport.

### Where HoBo deliberately differs

- **Multi-cloud + IaC + matching** — HoBo provisions *across providers* by context ([Plan 25](../design/platform-engineering.md#plan-25)); Convex is one backend.
- **Event-sourced replay/time-travel + audit** as the substrate ([Plan 11](../design/data-plane.md#plan-11)).
- **WASM-first polyglot runtime** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) vs Convex's TS/JS runtime.
- **Agent-native generation pipeline** generation of providers/implementations/definitions ([Plan 23](../design/generated-stack.md#plan-23)).

## Adversarial critique

- **The reactive model is the lock-in.** Everything good about Convex depends on its engine tracking
  read sets; there is no other implementation of that contract, so the application cannot move.
- **Scale characteristics of read-set tracking** are the interesting engineering question, and the
  one least documented publicly: invalidation fan-out is workload-dependent.
- **TypeScript-centric.** Other languages are second-class, which bounds the addressable audience.
- **Actions break the transactional story** by necessity — the moment an application talks to a
  payment provider, the clean model has an edge.
- **Self-hosting exists and is not the product.** The hosted service is where the operational quality
  lives.
- **A young platform holding the system of record** is a substantial bet for a business-critical
  application, and the migration path out is a rewrite.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Provider-abstract data ports** (*implemented*, ADR-0052/0081): HoBo's data kinds map to cloud
  natives rather than to one vendor's engine.
- **Event-sourced authority with replay** (*implemented*, ADR-0135) — architecturally a *stronger*
  substrate for reactivity than a document store, since the log is already an ordered change stream.
- **Scored placement and residency** (*implemented*, ADR-0146) have no analog in a single hosted
  backend.
- **Honest caveat, and it is the important one.** On live-query ergonomics Convex is ahead of HoBo,
  and the corpus's gap analysis already records this as the standout gap. HoBo has the better
  substrate and not the better developer experience.

## Better-together / integration posture

- **Borrow** — **precise read-set invalidation as a developer-facing contract**. HoBo's event log
  makes this mechanically easier than it is for a document database; what is missing is the
  ergonomic surface that turns projections into live queries.
- **Provider-target** — Convex behind HoBo's data ports is coherent for teams that want it.
- **Benchmark** on the live-data developer experience, which is the specific thing HoBo is measured
  against here.
- Not an adopt or displace target.

## Threats and lessons

1. **Live queries remain the standout gap in the corpus**, and this capture reaffirms it after a
   full pass across seventy-plus products. Nothing else has closed it.
2. **HoBo's event log is the right substrate for reactivity and is not exposed as one.** Projections
   already derive from an ordered change stream; making that a live-query surface is a smaller step
   than it appears, and belongs in its own implementation issue.
3. **Ergonomics beat architecture in data**, as everywhere else. Being able to explain reactivity is
   worth less than not having to think about it.

## Sources

- [docs.convex.dev](https://docs.convex.dev/) — queries, mutations, actions, schema, reactivity
- [get-convex/convex-backend](https://github.com/get-convex/convex-backend) — the open-source backend

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Scale characteristics of read-set invalidation and current self-hosting
parity were not verified in this pass and are not asserted.
