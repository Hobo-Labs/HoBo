---
type: Reference
title: "Authoring: Resources, Wiring, Config & DSL"
description: "This capability doc covers the authoring surface end to end: the resource catalog and the `.allow()` model, wiring and the manifest IR, configuration and secretless secrets, and th"
tags: [hobo, design]
---

# Authoring: Resources, Wiring, Config & DSL

This capability doc covers the authoring surface end to end: the resource catalog and the `.allow()` model, wiring and the manifest IR, configuration and secretless secrets, and the Hobo Code DSL — one model from declaration to deployable artifact.

> **Reference architecture:** the SDK & Authoring epic rollup lives at [`sdk-authoring-ifc-bindles`](../../src/draft/epic-proofs/sdk-authoring-ifc-bindles/README.md). It ties the relevant POCs into one mocked simulation and Pact inventory for IfC resource collection, config/secret refs, XAA/auth declarations, Hobo Code lowering, coverage/permission gates, topology, and local dev replay.

## Plan 21

> **Contracts & policy (gates):** the inferred (or explicitly narrowed) grant is also a **capability contract** ([Plan 29](./contracts-policy-flags.md#plan-29)) — the **required** scope (what the code uses) must be ⊆ the **granted** scope on the resolved provider; by default they're equal (granted = inferred-from-usage), and an explicit `.allow()` that narrows below usage is the contract failure `can-deploy` catches, not a runtime surprise.

### The permission model — inferred from usage, three effects
A resource's permissions are **inferred from how your code uses it**: resource-collection runs the component and static analysis reads which WIT verbs it calls, baking the least-privilege used-set into the manifest. That inferred grant drives **three** things at once:
1. **Least-privilege IAM** — the IaC adapter generates the minimal cloud policy ([Plan 4](./control-plane.md#plan-04)).
2. **WASM capability grant (link)** — the component is linked to *only* the provider interfaces it uses; everything else is denied by the wasm host ([Plan 20](./wasm-runtime-wit.md#plan-20)).
3. **Agent token scope** — the broker issues scoped tokens bounded to exactly those `(resource, verbs)` ([Plan 6](./ai-native-agent-auth.md#plan-06)).

```ts
// IfC-default authoring: resources declared inline; permissions inferred from use
import { bucket, kv, topic } from "@hobo/bindles";

const profiles = bucket("profiles");                        // profiles.read()/.write() → infers RW (wasi:blobstore)
const sessions = kv("sessions");                            // sessions.get()/.set()    → infers get/set (wasi:keyvalue)
const events   = topic("user-created").allow("publish");   // explicit .allow() = NARROW: cap to publish even if code uses more
```
Permissions are **deny-by-default**: a verb your code never calls is never granted — by IAM, link, or token. Inference yields exactly the used-set; **`.allow()` is an optional override** that only **narrows** it (assert a tighter contract — `can-deploy` fails if the code exceeds it) or grants a **dynamic** verb static analysis can't see. This unifies least-privilege IAM with wasm capability security and HoBo's agent auth.

### Catalog — resource → WIT port → permission verbs
| Resource | `@hobo/bindles` | WIT port | `.allow()` verbs | Equivalence (AWS/Azure/GCP/CF) |
|---|---|---|---|---|
| **API / HTTP** | `api(name)` | `wasi:http` (+ `hobo:http`) | [route-level security](#route-level-api-security) | API GW+Lambda / Container Apps / Cloud Run / Workers |
| **KV** (durable) | `kv(name)` | `wasi:keyvalue` | `get`,`set`,`delete` | DynamoDB / Cosmos / Firestore / KV — **durable** key-value store (source of truth) |
| **Cache** (ephemeral) | `cache(name)` | `hobo:cache` | `get`,`set`,`delete`,`invalidate` | Redis/Valkey / ElastiCache · Memorystore · Azure Cache · Momento · CF Cache — **ephemeral, TTL-first, evictable, never a source of truth** ([ADR-0118](./adr/03-data-plane.md#adr-0118)) |
| **Bucket** | `bucket(name)` | `wasi:blobstore` (+ `hobo:blob-events`) | `read`,`write`,`delete` | S3 / Blob / GCS / R2 |
| **Queue** (pull) | `queue(name)` | `hobo:queue` | `enqueue`,`dequeue` | SQS / Service Bus / Tasks / Queues |
| **Topic** (push) | `topic(name)` | `wasi:messaging` | `publish`,`subscribe` | SNS / Event Grid / Pub/Sub / **Kafka** (`@hobo/provider-kafka`) / Dapr pubsub (`@hobo/runtime-dapr`) / local — [ADR-0138](./adr/01-architecture-core.md#adr-0138) |
| **Secret** | `secret(name)` | `wasi:config/store` + `hobo:secrets` (versioned, [ADR-0113](./adr/02-identity-security.md#adr-0113)) | `put`,`access` *(access = latest or pinned version)* | Secrets Mgr / Key Vault / Secret Mgr |
| **Data** | `data(name)` | `hobo:data` (sub-interfaces `relational · document · graph · vector · key-value`, [ADR-0112](./adr/03-data-plane.md#adr-0112)) | `read`,`write`,`query`,`admin` | one abstract dep, paradigm-specific providers: relational/SQL · document/NoSQL · graph · vector · key/value ([ADR-0052](./adr/03-data-plane.md#adr-0052)) |
| **Schedule** | `schedule(name)` | `hobo:scheduler` | n/a | EventBridge / Timer / Cloud Scheduler |
| **WebSocket** | `websocket(name)` | `wasi:websocket` **(preview)** + `hobo:websocket` ext | `accept`,`connect`,`send`,`broadcast`,`subscribe` | API GW WS / Web PubSub / — — preview interface tracking the likely standard; principal-bound, rooms/broadcast, lifecycle as `ws.*`, migrates via upcaster ([ADR-0075](./adr/07-portability-extensibility.md#adr-0075)) |
| **Batch job** | `job(name)` | `hobo:job` (+ `vm`/`microVm`) | `submit` | AWS Batch / Azure Batch / Cloud Batch |
| **Website** | `web(name)` | static + `wasi:http` | n/a | CloudFront+S3 / Front Door+Blob / CDN+GCS |
| **Compute/service** | `service(name)` | component (exports `wasi:http`) | (binds below) | Fargate / Container Apps / Cloud Run / Workers |
| **Search** *(not a primitive — the query side of `data`)* | `data(name).query(...)`/`view(...)` | `hobo:data` query surface | `read`,`query` | **search is how you read `data`, not a separate resource** ([ADR-0034](./adr/03-data-plane.md#adr-0034)): full-text query is built into `data`; **vector/graph are opt-in packages** (`@hobo/vector`/`@hobo/graph`, [ADR-0081](./adr/03-data-plane.md#adr-0081)); `embed` is a vector-package capability ([Plan 32](./data-plane.md#plan-32)) |
| **Feature flag** | `flag(name)` | `hobo:feature-flag` | `eval`,`change` | built-in store / OpenFeature providers (flagd/LaunchDarkly) ([Plan 29](./contracts-policy-flags.md#plan-29)) |
| **Auth** (end-user) | `auth(name)` | `hobo:auth` | (verify/session) | federate+verify any IdP — **swappable adapters: WorkOS · Auth0 · Supabase Auth · Microsoft Entra ID** (+ Google/GitHub/Clerk/customJwt) + thin dev built-in; only registered ones considered, auto-generatable ([Plan 6](./ai-native-agent-auth.md#plan-06)/[ADR-0073](./adr/07-portability-extensibility.md#adr-0073)) |
| **Crypto** | `crypto(name)` | `hobo:crypto` | `encrypt`,`decrypt`,`sign`,`verify` | KMS / Key Vault / Cloud KMS / in-boundary HSM — **keys the app never holds**, brokered like secrets (see *Configuration & secretless secrets* below) |
| **Notify** | `notify(name)` | `hobo:notify` | `send` | one capability; **channels are types** (`email`/`sms`/`push`/`webhook`) — SES/SendGrid · Twilio/SNS · FCM/APNs · signed HTTP — a thin **cloud-messaging port** (typed templates, PrincipalRef recipients, policy-gated), shares the ops receiver port ([ADR-0059](./adr/03-data-plane.md#adr-0059)) |
| **Guardrail** | `guardrail(name)` | `hobo:guardrail` | `check` | built-in rules / Llama Guard / hosted moderation / local — **AI output safety** (moderation/PII/jailbreak/grounding) as a policy-gated step ([Plan 46](./governance-planes.md#plan-46)/[ADR-0061](./adr/02-identity-security.md#adr-0061)) |
| **UI render** | `ui(name)` | `hobo:ui-render` | `render`,`drive` | pluggable engines: OpenUI (UI from intent) · json-render (declarative render IR) · mcp-apps (MCP-driven app surfaces) — **app/UI generation** typed from the domain schema, design.md-gated, reactive to materializations ([ADR-0056](./adr/03-data-plane.md#adr-0056)) |
| **Experiment** | `experiment(name)` | `hobo:experiment` | `assign`,`expose`,`analyze` | the **Harness** experiment leg ("OpenExperiment") — A/B / multivariate: assignment + exposure + metrics + statistical analysis over OTEL + the event log; built-in default, adapters Statsig/GrowthBook/Optimizely/Eppo/Amplitude ([ADR-0083](./adr/02-identity-security.md#adr-0083)). *(Flags = `flag()`; canary/rollout is deploy-time delivery config, not an app resource.)* |

**Golden evals are not a catalog capability.** Every Camp hosts an **always-on `evals` sidecar** with two default suites over trainable code: **gold** (`hobo.evals.trainable-golden/v1`) is the ADR-0025 exact-match rubric over contract examples and recorded traces; **silver** (`hobo.evals.trainable-silver/v1`) runs `@hobo/fuzz` property oracles (seed-holds, deterministic, fail-closed, no pollution, bounded) against the same seeds and, when an invoker is supplied, the live trainable function. They score the trainable code, not occupancy or Bindle health. A project may add optional eval tests (`test:eval` / `*.eval.test.ts`) for extra training cases; those overlay the defaults. Offline they still run with the project's test suite. Live they share the app's Camp — not a `golden()` factory, not a `hobo:golden` port ([ADR-0082](./adr/02-identity-security.md#adr-0082)). The draft proof artifacts now match: `hobo-bindles-resource-catalog` no longer exports the factory, and the `bindles-api-freeze-contract` snapshot and collector pact were re-cut without it, so no artifact in the repo still advertises a capability the ADR removed.

The catalog reaches **capability parity with Nitric and Vercel** ([ADR-0002](./adr/01-architecture-core.md#adr-0002)): APIs, schedules, AI (`search` + its vector/graph extensions, `guardrail`), websites, storage, secrets/config, durable data (`data`/`kv`) + ephemeral cache (`cache`, [ADR-0118](./adr/03-data-plane.md#adr-0118)), messaging (`topic`/`queue`/`notify`), feature flags, and functions/workflows (`service`/`job` + the durable runtime) — every capability expressed as a resource behind a port. Cross-cloud equivalence classes are owned by [Plan 4](./control-plane.md#plan-04); this table is the resource→port view.

**Full Nitric building-block parity (one resource per block, each a WIT interface).** Every Nitric building block has a catalog row above, each backed by a WIT port ([ADR-0069](./adr/01-architecture-core.md#adr-0069)). **Queue and topic/pub-sub are the runtime's messaging building blocks**, backed by WIT interfaces and named to match them ([Plan 20](./wasm-runtime-wit.md#plan-20)):

| Nitric building block | HoBo resource | WIT interface | `.allow()` verbs |
|---|---|---|---|
| APIs / HTTP routing | `api(name)` | `wasi:http` (+ `hobo:http`) | [route-level security](#route-level-api-security) |
| Schedules (cron) | `schedule(name)` | `hobo:scheduler` | n/a (cron trigger) |
| Topics & subscriptions (pub/sub) | `topic(name)` | `wasi:messaging` | `publish`,`subscribe` |
| Queues | `queue(name)` | `hobo:queue` | `enqueue`,`dequeue` |
| Key/value store | `kv(name)` | `wasi:keyvalue` | `get`,`set`,`delete` |
| Storage / blob (buckets) | `bucket(name)` | `wasi:blobstore` (+ `hobo:blob-events`) | `read`,`write`,`delete` |
| Secrets | `secret(name)` | `wasi:config/store` + `hobo:secrets` (versioned, [ADR-0113](./adr/02-identity-security.md#adr-0113)) | `put`,`access` *(access = latest or pinned version)* |
| Data (relational/document/graph/vector/kv) | `data(name)` | `hobo:data` (sub-interfaces `relational · document · graph · vector · key-value`, [ADR-0112](./adr/03-data-plane.md#adr-0112)) | `read`,`write`,`query`,`admin` |
| Websockets | `websocket(name)` | `wasi:websocket` (preview) + `hobo:websocket` ext | `accept`,`connect`,`send`,`broadcast`,`subscribe` |

HoBo's runtime provides **everything Nitric's runtime does** — the full building-block set above — but realized as **WIT interfaces**, with providers implementing the WIT interface (not Go plugins) and invoked over the **wRPC membrane** ([ADR-0069](./adr/01-architecture-core.md#adr-0069)). A building block is just a port; HoBo's own durable workflow/actors, materializations, auth, and AI ports (the rest of the catalog) sit alongside the Nitric set on the same membrane.

### Route-level API security
The `api()` resource's `.allow()` column is **not** a verb list like `kv` or `topic` — it names **route-level security**: who may call which HTTP route, and with what verified identity. This is the authoring surface for Nitric's `oidcRule` / `securityRule` per route and `api.use()` middleware ([ADR-0114](./adr/02-identity-security.md#adr-0114)).

**Three layers — default, override, public opt-out.**
1. **API-level default** — `api(name, { security: [rules] })` declares named security rules (OIDC/JWT, API key, custom) that apply to every route unless overridden.
2. **Per-route override** — each `app.get/post/...()` attaches a `security` rule name (or inline rule) for that path+method.
3. **Public opt-out** — `{ public: true }` on a route explicitly marks it unauthenticated; deny-by-default holds for all other routes.

```ts
import { api } from "@hobo/bindles";

const defaultRule = api.oidcRule({
  name: "default",
  issuer: "https://accounts.example.com",
  audiences: ["https://api.example.com"],
});

const app = api("main", { security: [defaultRule] });

app.get("/health", { public: true }, async (ctx) => ctx.json({ ok: true }));
app.get("/todos/:id", { security: "default" }, async (ctx) => { /* ctx.user set */ });
app.post("/admin/todos", { security: "admin" }, async (ctx) => { /* stricter rule */ });
```

**Middleware seam — same obligation as Plan 29 auth middleware.** Custom auth (`api.use(middleware)`) is an **ordered middleware chain** on the `hobo:http` port, evaluated **before** the handler and **after** route matching. It is the runtime realization of the Plan 29 policy obligation *allow public endpoint → require auth middleware* ([Plan 29](./contracts-policy-flags.md#plan-29)): when policy mutates a graph to add auth, it inserts middleware bindings on the affected routes. Named `security` rules and `use()` middleware compose in declaration order — rules verify identity (`ctx.user` / `ctx.identity`), middleware may enrich or reject the request.

```ts
async function requireApiKey(ctx, next) {
  if (ctx.req.headers["x-api-key"] !== ctx.secrets.apiKey) {
    ctx.res.status = 401;
    return ctx;
  }
  return next(ctx);
}
app.use(requireApiKey);   // applies to all non-public routes on this api
```

**Manifest IR — per-route `security` entries.** Resource-collection lowers declarations into the manifest IR ([Plan 21](#wiring--the-manifest-ir-aspire-model)) as explicit per-route `security` on the `api` resource:

```jsonc
"main": {
  "type": "api.v1",
  "port": "hobo:http",
  "security": {
    "default": { "type": "oidc", "issuer": "https://accounts.example.com",
                 "audiences": ["https://api.example.com"] },
    "admin":   { "type": "oidc", "issuer": "https://accounts.example.com",
                 "audiences": ["https://api.example.com"], "scopes": ["admin"] }
  },
  "middleware": ["requireApiKey"],
  "routes": [
    { "method": "GET",  "path": "/health",       "security": "public" },
    { "method": "GET",  "path": "/todos/:id",    "security": "default" },
    { "method": "POST", "path": "/admin/todos",  "security": "admin" }
  ]
}
```

**Enforcement — gateway + `hobo:http`.** At deploy, the gateway/IaC adapter materializes provider-native authorizers (API Gateway authorizer, Cloud Run/IAP, Container Apps auth, Workers access rules) from the `security` block. At runtime, the **`hobo:http` extension** ([Plan 20](./wasm-runtime-wit.md#plan-20)) enforces the same rules before invoking `wasi:http/incoming-handler`: JWT/OIDC verification via the linked `hobo:auth` port ([Plan 6](./ai-native-agent-auth.md#plan-06)), middleware chain execution, and principal injection into `ctx.user` / `ctx.identity`. Deny-by-default: a route with no matching rule and no `public` opt-out is rejected.

**Local dev enforces security (Nitric gap closed).** Unlike Nitric — where `oidcRule` / `securityRule` are **not enforced in `nitric start`** — `hobo dev` evaluates the same per-route `security` entries and middleware chain against the contract-asserted dev principal ([ADR-0070](./adr/02-identity-security.md#adr-0070)). Public routes stay public; protected routes require a fixture principal whose claims satisfy the rule; middleware runs identically. Authorization (policy + `.allow()`) is never bypassed — only the IdP verification path is fixture-satisfied offline.

> **Data resources vs the data plane.** For an app's **domain data**, the default path is **not** raw `ctx.bindings.db` access — it's the event-sourced **command → aggregate → projection** model ([Plan 32](./data-plane.md#plan-32)/[ADR-0050](./adr/03-data-plane.md#adr-0050)). The `data`/`kv`/`bucket`/`search` resources here are then **how a projection *sink* is realized** (a data architect maps a read model onto one via Matching — for `data`, the paradigm + backend is a provider/Matching choice, [ADR-0052](./adr/03-data-plane.md#adr-0052)), plus the **escape hatch** for direct access and the home of **adopted authoritative-external** stores ([ADR-0041](./adr/07-portability-extensibility.md#adr-0041)). They remain first-class resources; domain reads/writes go through `command`/`repo`/`view`, not hand-written queries by default.
>
> **Opt-in paradigm packages (Encore-style ergonomics, [ADR-0081](./adr/03-data-plane.md#adr-0081)).** `data(name)` is the **portable default** (paradigm chosen by Matching). A developer who wants a paradigm-idiomatic typed abstraction instead opts into **`@hobo/sql`** / **`@hobo/vector`** / **`@hobo/graph`** / **`@hobo/document`** — idiom layers over the same `hobo:data`/`hobo:search` ports that map to cloud natives by Matching and stay overridable (`.with()` native pin · Resource Definition · `.raw()` dialect). A deliberate, surfaced specialization (equivalence-class-bounded), not the default.

### IfC-default authoring (resources emerge from code)
The **default** authoring mode is Nitric-style: declare resources inline and HoBo **infers their permissions from how you use them**; the deploy pipeline runs each component in **resource-collection mode** to capture declarations + the used-verb set into the **manifest IR** (below). Handlers attach to resources directly:
```ts
import { api, kv } from "@hobo/bindles";
const todos = kv("todos");   // todos.get()/.set() below → infers allow:[get,set]
const app = api("main");
app.get("/todos/:id", async (ctx) => ctx.json(await todos.get(ctx.params.id)));
app.post("/todos",    async (ctx) => { await todos.set(crypto.randomUUID(), await ctx.json()); });
```
The explicit `bindle()` topology ([Plan 2](./sdk-api.md#plan-02)) remains available as the **advanced/escape-hatch** mode when you want to declare the graph by hand or do things collection can't infer.

### Cross-app access (XAA) — declare the app, infer the scope
Reaching an *external* app on the end-user's behalf is a binding like any other, and its OAuth scope is **inferred from declaration + usage** — you no more hand-list scopes than you hand-list `.allow()` verbs ([ADR-0084](./adr/02-identity-security.md#adr-0084)/[Plan 6](./ai-native-agent-auth.md#plan-06)):
```ts
import { api, connector } from "@hobo/bindles";

const asana = connector("asana");         // DECLARATION: an external connector dependency; typed client from Asana's Capability Manifest
const sync  = api("sync");

sync.post("/ticket", async (ctx) => {
  // USAGE: the operations you call infer the least-privilege XAA scopes
  await asana.tasks.create({ name: ctx.body.title, assignee: ctx.user.id });   // → infers scope tasks:write, on behalf of ctx.user
});
```
- **Declaration** names the target (and that access is *on a user's behalf*); the typed client is generated from the target's Capability Manifest `auth.json`, which advertises the *available* scopes + resource indicators.
- **Usage** — collection + static analysis read which client operations the code calls and map them to the target's scopes, baking the **least-privilege requested subset** into the manifest, exactly like resource verbs:
  ```jsonc
  "asana": { "type": "connector.v1", "via": "xaa", "audience": "urn:asana:app",
             "onBehalfOf": "user", "allow": ["tasks:write"] }   // inferred from usage, not declared
  ```
- **Brokered automatically** — on the call the runtime obtains an XAA token (ID-JAG → access token, [Plan 6](./ai-native-agent-auth.md#plan-06)) scoped to exactly the inferred set, for `ctx.user`; you never touch a token or a scope string. The raw escape hatch is `connector("asana").connection().token()` (scopes default to the connection's inferred set; pass an explicit subset only to narrow).
- **Override = narrow only** — `connector("asana").allow("tasks:read")` asserts a tighter contract; `can-deploy` fails if the code uses more, and a **policy deny-ceiling** ([ADR-0074](./adr/02-identity-security.md#adr-0074)) can cap it regardless. Deny-by-default holds: a scope the code never exercises is never requested.

### Handlers, events & triggers (parity with Nitric "services")
Each entry point compiles to a component exporting the right WIT interface:
- HTTP routes → `wasi:http/incoming-handler`.
- `topic.subscribe`, `bucket.on('write', …)`, `schedule.cron(…)`, `queue` workers, `websocket.on(…)`, `job.handler(…)` → host triggers that invoke the component. These also flow through HoBo's durable runtime ([Plan 2](./sdk-api.md#plan-02)) so a subscriber can be a workflow/saga with replay + compensation — a capability Nitric lacks.

### Declarations follow varlock's declarative schema
Resource declarations, config items, and the DSL surface all use **varlock's declarative schema pattern** ([ADR-0027](./adr/02-identity-security.md#adr-0027)): each item is a **typed, annotation-driven declaration** carrying its **type, required, sensitivity, and source**. The annotations are provider-neutral; Matching and the Camp's adapters consume them.

### FinOps — inline budget & cost-availability

FinOps budget controls are **scope declarations**, not catalog resources — they carry no WIT port and are not inferred from component usage. Declare them inline on **Camp**, **Bindle**, **agent**, or **connector** policy surfaces via `@hobo/bindles` / `@hobo/camps` helpers; resource-collection folds them into the manifest IR `policy` block and the policy plane enforces them at deploy/runtime ([ADR-0039](./adr/02-identity-security.md#adr-0039), [Plan 5](./reliability-observability-cost.md#plan-05)).

| Declaration | SDK helper | Typical scope | Policy-plane effect |
|---|---|---|---|
| **Budget** | `budget({ softLimitUsd, hardLimitUsd, period })` | camp · tenant · bindle | soft crossing → warn obligation; hard crossing → deny at gate |
| **Spend cap** | `.policy({ spendCapUsd })` on `agent()` / `connector()` | agent · connector | approve/deny gate for autonomous spend ([Plan 6](./ai-native-agent-auth.md#plan-06)) |
| **Cost-availability profile** | `costAvailabilityProfile({ budgetUsd, availabilitySlo, tiers, strategy })` | camp · bindle | spend-velocity → `allow-degraded` + durable tier obligation before hard-stop |

```ts
import { camp } from "@hobo/camps";
import { budget, costAvailabilityProfile } from "@hobo/bindles";
import app from "./src/app";

const prod = camp("prod");
prod.import(app);
prod.policy({
  budget: budget({ softLimitUsd: 4000, hardLimitUsd: 5000, period: "monthly" }),
  costAvailabilityProfile: costAvailabilityProfile({
    budgetUsd: 5000,
    availabilitySlo: 0.999,
    tiers: [
      { name: "nominal", upToBudgetFrac: 0.80, slo: 0.999 },
      { name: "reduced", upToBudgetFrac: 0.95, slo: 0.99, shed: ["batch", "analytics"] },
      { name: "minimal", upToBudgetFrac: 1.00, slo: 0.95, shed: ["non-critical"] },
    ],
    strategy: "shed-low-priority-first",
  }),
});
```

Resources and handlers may carry a **`priority`** label (`critical` \| `standard` \| `low`) so degradation tiers shed lowest-priority load first. The profile's `budgetUsd` may be omitted when a sibling `budget.hardLimitUsd` is present — the policy normalizer treats them as the same period cap.

**`hobo plan` surfacing.** Plan preview is read-only and surfaces FinOps declarations alongside per-resource cost estimates ([Plan 7](./developer-experience.md#plan-07), [HOBO-125 proof](./proofs/hobo-125-plan-preview/index.md)). After the resource table, `hobo plan` emits a **Cost & budget** block:

```text
Cost & budget (camp prod, monthly)
  projected:  $63.50/mo
  budget:     $5,000 hard / $4,000 soft  →  headroom $4,936.50
  profile:    nominal tier (80% cap)      →  velocity OK for period
```

- **Projected monthly cost** — sum of matched resource list estimates for the selected Camp.
- **Budget headroom** — declared `softLimitUsd` / `hardLimitUsd` (or profile `budgetUsd`) vs projected spend; crossing soft adds a **warning**; crossing hard adds a **would-deny** gate annotation (plan stays read-only).
- **Degradation preview** — when MeteringView spend velocity would cross a `costAvailabilityProfile` tier before period end, the plan names the tier and shed targets as a **warn-only** line (runtime enforcement remains policy-plane `allow-degraded` + `spend.DegradationRequired`, not a plan block).

The machine envelope (`hobo plan --json`) carries the same facts under `cost` (estimate) and `budget` (declared limits, headroom, tier preview, gate annotations) so CI and MCP clients can post approvable diffs without parsing human text.

Manifest IR sketch (folded beside resources):

```jsonc
"policy": {
  "budget": { "softLimitUsd": 4000, "hardLimitUsd": 5000, "period": "monthly" },
  "costAvailabilityProfile": {
    "budgetUsd": 5000,
    "availabilitySlo": 0.999,
    "strategy": "shed-low-priority-first",
    "tiers": [
      { "name": "nominal", "upToBudgetFrac": 0.80, "slo": 0.999 },
      { "name": "reduced", "upToBudgetFrac": 0.95, "slo": 0.99, "shed": ["batch", "analytics"] }
    ]
  }
}
```

Executable contract: [`inline-budget-authoring`](../../src/draft/exp-proofs/dx/inline-budget-authoring/README.md) proof (HOBO-693).

### DNS is a Yard-level resource, not app/Bindle-level
DNS and custom domains are **not** in the app-level catalog ([ADR-0035](./adr/07-portability-extensibility.md#adr-0035)). DNS is a **Yard-level** resource — provider-global, with **per-Camp overrides** — so a Bindle never declares it. Custom-domain binding (ACME DNS-01 certs; failover/weighted/latency across Camps) is resolved at the Yard layer and applied per Camp; the app references endpoints, not zones.

### Notes
- `hobo:blob-events` is a HoBo WIT shape where no standard `wasi:*` exists; `hobo:websocket` is a **thin extension over the preview `wasi:websocket`** ([ADR-0075](./adr/07-portability-extensibility.md#adr-0075)), not a standalone shape.
- A relational `data` provider's schema migrations are specified in [Plan 32](./data-plane.md#plan-32) ([ADR-0032](./adr/03-data-plane.md#adr-0032)): declarative desired-schema + auto-diff (raw `.up.sql`-style steps as an escape hatch), gated **expand/backfill/contract** apply + snapshot rollback, and cross-cloud move within an equivalence class.
- `.allow()` verbs are per-resource-type typed enums; each provider's IAM adapter maps them to that provider's actions.
- The programmable surface is **WIT/WASM**: collection runs each component to capture declarations, and any Component-Model language authors Bindles. TypeScript is the **first reference implementation**, not a requirement ([ADR-0069](./adr/01-architecture-core.md#adr-0069)) — non-TS languages are collected the same way (run-to-collect), with static analysis as a supplement.

### Wiring & the manifest IR (Aspire model)

> **S1-15 production (HOBO-605):** bind-reference wiring lives in `@hobo/bindles` (`packages/bindles/src/wiring/*`), topology scope objects in `@hobo/camps` and `@hobo/yards`, and local binding resolution in `@hobo/camps` + `@hobo/runtime-local`. Draft POC: [`s1-15-bind-wiring-topology-contract`](../../src/draft/technical-proofs/s1-15-bind-wiring-topology-contract/README.md).

> **Deltas & Sets (Humanitec parity).** The manifest IR is the immutable **Deployment Set**; a **Delta** is a mutable diff against it (draft→review→promote), both event-sourced ([Plan 25](./platform-engineering.md#plan-25)). Placeholders/output-refs align to Humanitec syntax (`${resources.<type>.<class>#<id>.outputs.<name>}`, `${context.*}`) — see [Plan 25](./platform-engineering.md#plan-25). Besides direct apply, a **GitOps publisher** can write the Set to Git for Argo/Flux ([Plan 25](./platform-engineering.md#plan-25)).

`bind` is a **reference**: lazy, convention-based, adopting Aspire `.WithReference()` semantics.
- Declaring `bind: { db }` (or referencing a resource inside a handler) records a **dependency edge** (drives the DAG + link), and **injects connection info/endpoints** into the consumer.
- **Lazy resolution** (Aspire's `ReferenceExpression`): references resolve at deploy/runtime, so the *same component* runs locally and on any provider with no code change.
- **Convention (ADR-0141):** binding delivery is the **WIT membrane** — bind edges → manifest **links** → provider exports → typed `ctx.bindings.<name>`. **Secret-shaped process env is forbidden** (`ConnectionStrings__*`, credential URIs). Optional **public** HTTP discovery keys (`services__<name>__http__0`) may be projected for non-credential endpoints only.

```ts
const db  = data("db");                          // abstract data dep; paradigm + backend resolved by Matching
const api = service("api", { bind: { db } });    // api gets a typed db client; edge + link recorded
// links only — no ConnectionStrings__* ambient grants (ADR-0141)
```

**Config for any component *or* container is uniform.** Adopt Aspire's `addContainer(...)` surface, applied identically to wasm components and OCI containers (wasm-on-OCI is just another image). **`addContainer(...)` both wires *and* builds** ([ADR-0005](./adr/01-architecture-core.md#adr-0005)): it records the dependency edge/link *and* drives the build of the workload through the dagger-adjacent programmable **BuildProvider**, which **defaults to wasm-on-OCI** (and is swappable to plain OCI). One call covers wiring and the build step:
- **Endpoints:** `withHttpEndpoint(port, targetPort, name)`, `withEndpoint({ scheme, port, targetPort, external, protocol })`.
- **Env / args:** `withEnvironment(k, v)`, `withArgs(...)` (values may be lazy references).
- **Storage:** `withBindMount(src, dst, readOnly?)`, `withVolume(name, dst)`.
- **Lifecycle:** `withLifetime("persistent")`, `withExplicitStartup()`, `waitFor(dep)`, `waitForCompletion(job)`.
- **Health:** `withHttpHealthCheck(path)` / `withHealthCheck()` — feeds rollout gates ([Plan 5](./reliability-observability-cost.md#plan-05)).
```ts
addContainer("cuda-job", "ghcr.io/acme/cuda-job:1.2")    // wires + builds via BuildProvider (wasm-on-OCI default)
  .withEndpoint({ port: 8080, scheme: "http" })
  .withEnvironment("MODEL", "yolo")
  .withVolume("models", "/models")
  .withHttpHealthCheck("/healthz");
```
The BuildProvider is the programmable build seam: a prebuilt image short-circuits the build; a source dir is compiled (wasm-on-OCI by default) before the edge/link is finalized.

**Local dev (`hobo dev`):** workloads run with the same **link/capability** membrane as deploy. Optional public endpoint discovery may inject non-credential `services__*` keys; **never** credential `ConnectionStrings__*`. Wasm-on-OCI images run on `runtime-local`. Fidelity is labeled per the [ADR-0042](./adr/07-portability-extensibility.md#adr-0042) matrix.

**Annotations are typed extensibility (`.with(...)`).** Aspire attaches behavior via resource **annotations** consumed by deploy tools. HoBo's existing provider-specific options pattern **is** this: `.with(provider.options())` adds typed annotations that the resolved Provider/IaC adapter consumes; non-resolved providers' annotations are inert ([Plan 2](./sdk-api.md#plan-02)). First-party annotations (health, lifetime, replicas, scaling, residency) are typed and provider-neutral. `scaling {min,max}` is consumed by the Camp's `component-host` scheduler ([ADR-0108](./adr/01-architecture-core.md#adr-0108)).

**The manifest IR (deployment intermediate representation).** Resource-collection emits a **HoBo manifest** — the union of Nitric's resource spec and Aspire's `aspire-manifest.json`. It is the single artifact the Planner/Orchestrator consume and that publishers/IaC adapters render to real infra. The production schema, CUE constraints, and `parseManifest` loader live in [`packages/bindles/data-models/`](../../packages/bindles/data-models/) (`hobo.manifest/v1`). Sketch:
```jsonc
{
  "schema": "hobo.manifest/v1",
  "resources": {
    "db":  { "type": "data.v1", "port": "hobo:data", "paradigm": "relational", "allow": ["query"],
             "connectionString": "{db.connectionString}" },
    "api": { "type": "component.v1", "image": "oci://.../api@sha256:…", "runtime": "wasm",
             "exports": ["wasi:http/incoming-handler"],
             "links": [ { "import": "hobo:data", "to": "db" } ],
             "endpoints": { "http": { "scheme": "http", "targetPort": 8080, "external": true } },
             "annotations": { "scaling": { "min": 1, "max": 10 }, "with": { "aws.fargate": { "cpu": 512 } } } },
    "site":{ "type": "website.v1", "bind": ["api"] }
  }
}
```
- **Lazy tokens** may appear in non-secret placeholders only; **connection-string ambient env grants are forbidden** (ADR-0141). Prefer links + `fromBinding`.
- **`links`** are the wasm capability bindings ([Plan 20](./wasm-runtime-wit.md#plan-20)); **`allow`** mirrors the permission model above.
- **FinOps plan-time bridge.** During **`hobo plan`**, the Planner lowers each manifest resource node to provider-neutral **`ResourceIntent`** before FinOps routing ([Plan 04](./control-plane.md#plan-04), [finops-budget-routing-control-plane.md](./finops-budget-routing-control-plane.md#ifc-and-hobo-plan-spine)); provider-specific `.with(...)` annotations stay in the manifest until after `RoutingDecision`.
- The manifest is **content-addressed and event-sourced** (`deployment.Planned` carries it), so it's auditable/replayable ([Plan 11](./data-plane.md#plan-11)).
- SDK authoring tests also materialize the manifest IR as a stable JSON artifact
  under `contracts/manifests/`, analogous to Pact consumer tests writing
  `contracts/pacts/*.pact.json` for broker upload. The `hobo collect --out`
  CLI path remains the manual form; the SDK path proves tests can publish the
  same IR without shelling through the CLI.

**Publishers (deploy targets).** Like Aspire publishers / `azd`, the manifest is rendered by pluggable backends: the default **Pulumi Automation API** adapter ([Plan 4](./control-plane.md#plan-04)), plus Crossplane (k8s), and container/wasm-host targets (SpinKube/containerd-wasm, wasmCloud lattice). The manifest decouples *what to deploy* from *how*.

**PortabilityReport ([ADR-0024](./adr/07-portability-extensibility.md#adr-0024)).** A **plan-time, event-sourced scorecard** computed from the manifest IR + the Matching result, emitted alongside `deployment.Planned` (event **`deployment.PortabilityReported`**) so "how locked-in is this Bindle?" is an auditable, replayable fact — not a manual audit. It complements `hobo doctor` (interactive warnings) with a structured per-deploy record:
- **Portability %** — the fraction of resources backed by a provider **equivalence class** with **≥2-cloud capability** (a single-provider-only resource lowers the score).
- **Lock-in sources, with severity** — provider `.with()` blocks, raw escape hatches (`.raw(driver => …)` dialect leaks, [Plan 32](./data-plane.md#plan-32)), **host-`.with()`** options ([ADR-0031](./adr/01-architecture-core.md#adr-0031)), and **paradigm mismatches** (cross-paradigm-only data features, paradigm-class-scoped per [ADR-0024 §Detect lock-in](./adr/07-portability-extensibility.md#adr-0024)/[ADR-0052](./adr/03-data-plane.md#adr-0052)).
- **Per-resource provider-equivalence-class** — the class chosen + **why other members were rejected** (reuses the rejected-candidate reasons in `match.Decided`, [ADR-0033](./adr/01-architecture-core.md#adr-0033)).
- **Upgrade readiness** — the pinned **`component-host` + `wasi:*` versions** ([ADR-0031](./adr/01-architecture-core.md#adr-0031)) and whether a host upgrade path/upcaster is available, so portability and upgradability read off one report.

Manifest interop notes: the schema (`hobo.manifest/v1`) stays interop-close to Aspire's structure for resource graphs, but **HoBo rejects Aspire credential-env delivery** (ADR-0141). Public endpoint discovery only; credentials never as process env.

### Configuration & secretless secrets

Apps need configuration (URLs, flags, tuning) and credentials (DB access, third-party API keys). The antipattern everyone falls into is static secrets baked into env files, images, IaC, or — worst — the event log. HoBo issues **keyless workload identities** and brokers short-lived provider tokens ([Plan 6](./ai-native-agent-auth.md#plan-06)); config and secrets ride that same path by default, and the SDK surface for loading them is built around it.

**Principles.**
1. **Secretless-first.** The best secret is no secret: a bound resource is reached via the app's **SVID → brokered short-lived token**, so there is nothing to store or leak ([ADR-0008](./adr/index.md)).
2. **References, not values.** Config/secret declarations resolve to **refs** (a pointer to a provider secret store path, a binding, or a federation trust), resolved **at use-time, per Camp**. A value never lives in the `Bindle`, the Camp config, or the event log.
3. **Secretless is the default; provider specifics are a pluggable `secrets` port adapter.** The default identity path — SVID → SVID-brokered short-lived tokens, OIDC federation — stays the default. Cloud-specific IAM, keys, and certs plug in through a **`secrets` port adapter / extension per provider** ([ADR-0027](./adr/02-identity-security.md#adr-0027)). Because a **Yard owns provider selection** and a Camp **infers** provider on attach, *where* a secret/config actually comes from (Key Vault vs Secrets Manager vs Vault; which region) and *which* adapter resolves it is a **Yard-provider concern realized at the Camp** after attachment; the Bindle only declares *what it needs*. Overriding the default identity path with a cloud-native one is a Yard/Camp attachment + extension change, not an app edit.
4. **Every access is audited; values are never telemetry.** Secret reads are `token.Used` / `secret.Accessed` events; OTel/OpenInference spans and `ctx.log` redact values ([Plan 5](./reliability-observability-cost.md#plan-05)).

**SDK surface.** Declared inline (IfC) alongside resources; read via `ctx.config`. Each item is a **varlock-style declarative schema** entry ([ADR-0027](./adr/02-identity-security.md#adr-0027)) — typed and annotation-driven, carrying its **type, required, sensitivity, and source** — so `can-deploy` can validate the config surface without ever touching values:
```ts
import { config, secret, secretRef, env, fromBinding } from "@hobo/bindles";

export const appConfig = config({
  LOG_LEVEL: env.string().default("info").enum(["debug", "info", "warn", "error"]),
  FEATURE_X: env.boolean().default(false),
  MAX_CONCURRENCY: env.int().min(1).max(1000).default(32),
  DB_URL: secret.string().required().source("bound-resource"), // prefers identity
  API_KEY: secret.string().sensitive().source("provider-federation"),
  LEGACY_PASSWORD: secret.string().sensitive()
    .source("static-escape").ttl("7d").rotation("required"),
  // Alternatives still supported:
  DB: fromBinding("db"),                   // secretless: brokered token via the bind
  STRIPE: secretRef("stripe/api-key"),     // residual value-ref → Camp secrets port at use-time
});

export const charge = step(async (o: Order) => {
  // Sensitive fields resolve to refs/placeholders in agent paths; residual material
  // is broker-internal or mediated via the secretless connector (never plaintext in events).
  const stripe = await ctx.config.STRIPE();
  // ...
});
```
- `env.string()/.boolean()/.int()/.json()` — non-secret typed config fields (also `env({ KEY: value })` for Camp annotation injection). Defaults live in the Camp Deployment Set ([Plan 25](./platform-engineering.md#plan-25)).
- `secret.string()` — sensitive schema fields with explicit `source` ranking (`bound-resource` > `provider-federation` > `camp-value` > `static-escape`). Dual with residual catalog resource `secret(name)` for managed stores.
- `fromBinding(name)` — **preferred**: no secret at all; the bound resource is reached with the app's SVID-brokered token (the `bind` edge already wires identity-aware connectivity, [Plan 12](./security-networking.md#plan-12)).
- `secretRef(ref)` — a genuine third-party secret; `ref` is a logical name resolved per-Camp to the provider's `secrets` port path; the value is fetched at use-time and held in memory, never persisted. *(Named `secretRef` for value-reads; catalog `secret(name)` **declares a managed secret store** — residual Nitric parity only.)*

**Versioned managed secrets (`secret(name)` + `hobo:secrets`).** The `secret(name)` catalog resource
backs a versioned managed store ([Plan 20](./wasm-runtime-wit.md#plan-20)/[ADR-0113](./adr/02-identity-security.md#adr-0113)):
`put` yields a new `version-id`, `access` reads the latest value or a pinned version (version
pinning is an argument to `access`, not a separate `.allow()` verb), and `list-versions` supports
audit and rollback. `secret.Accessed` events carry the resolved version-id. This is the
Nitric-parity managed-store surface; **secretless brokering via identity federation + `fromBinding` / `secretRef` / ranked `config()` remains the default** ([ADR-0027](./adr/02-identity-security.md#adr-0027)). Residual classical credentials that cannot be pure identity are **mediated** by the secretless connector (`@hobo/connectivity`) so the workload never holds the value.

**The resolution ladder (secretless-first).**
```mermaid
flowchart TD
  NEED["app needs config/secret X"] --> KIND{declared as}
  KIND -->|fromBinding| BIND["SVID -> brokered short-lived token<br/>(no secret stored)"]
  KIND -->|secretRef| FED{provider federation<br/>available?}
  KIND -->|env| CFG["non-secret value from the Camp's Deployment Set"]
  FED -->|yes| STS["broker token -> read from provider secret store at use-time<br/>(Key Vault / Secrets Manager / Vault)"]
  FED -->|no| ESCAPE["bounded static-secret escape hatch<br/>(TTL + rotation + audited + opt-in, ADR-0023)"]
  BIND --> AUDIT["token.Used / secret.Accessed event; value never logged"]
  STS --> AUDIT
  ESCAPE --> AUDIT
```
1. **Bound resource** → SVID-brokered token (zero stored secret). Default for `data`/`queue`/`bucket`/etc.
2. **Secret with provider federation** → broker a scoped token, read the value from the provider's secret store at use-time.
3. **Non-secret config** → typed value from the Camp's Deployment Set (no broker needed).
4. **Static-secret escape hatch** → only when a provider offers no federation/secret-store path. **Bounded, concretely:** max TTL **≤ 7 days** (default; per-Camp tunable down), **rotation enforced** (a key past TTL fails closed with a typed `SecretExpiredError`, it does not hang), **every fetch audited** (not just grant/revoke), and **in-process cache bounded** (short TTL; each cache miss re-audits) — explicit opt-in ([ADR-0023](./adr/02-identity-security.md#adr-0023)). `hobo doctor` warns when this path is used where federation exists ([Plan 7](./developer-experience.md#plan-07), FR-014).

**Per-Camp binding under a Yard (where values actually come from).** The Bindle declares *needs*; after a Camp **attaches to (or is inferred under) a Yard**, resolution uses that **Yard's provider** adapters for *where* sources live, e.g.:
```ts
// Camp is provider-neutral; Yard owns cloud. Config sources resolve via Yard provider adapters.
const prod = camp("prod").config({
  STRIPE: fromSecretStore("secretsmanager", "prod/stripe"),   // store kind; cloud from Yard
  LOG_LEVEL: "warn",
});
// yard("aws", { provider: aws(), camps: [prod] })  → AWS Secrets Manager
// re-home via Trail to yard("azure", …)           → Key Vault (same Bindle; no app edit)
```
The same Bindle under an Azure Yard resolves `STRIPE` from Key Vault — **no app-code change** (the portability promise, [ADR-0024](./adr/07-portability-extensibility.md#adr-0024), [yard-first-placement](./adr/yard-first-placement.md)). Resolution decisions are recorded as `config.Resolved` (ref → source **+ Camp + Yard provider**, never the value).

**Multi-Camp / multi-Yard drift.** Because each Yard's secret store is independent, the *same logical secret* can diverge across Camps on different Yards (rotated in AWS, stale in Azure). HoBo does **not** sync secret values (it never holds them), but `hobo doctor` / `hobo verify` compare resolved **refs across an environment group** and warn on a key that is missing or maps inconsistently; `config.Resolved` (ref + Camp) makes drift inspectable in the audit log. Value correctness remains the secret-store owner's responsibility.

**Events & audit.**
- `config.Resolved` — a declared key bound to a source (binding / secret-store path / federation trust); carries the *ref* + Camp, never the value.
- `secret.Accessed` — a use-time fetch, joined to the run/agent + the brokered `token.Used` (the [CredentialAudit](./data-plane.md#plan-11) projection answers "who read which secret, when, with which token"). `secret.Unavailable` — a failed fetch (store down / denied).
- **Redaction is at capture time, not export.** Values are scrubbed **before** a span/event is stored — so a secret never lands in the event log, OTel/OpenInference spans, error messages, or **training trajectories** ([Plan 23](./generated-stack.md#plan-23): a `"use training"` method that calls `ctx.config.STRIPE()` must not leak the value into its trajectory). Values that must transit a step's I/O are per-run encrypted.

**Local development (`hobo dev`).** The local Camp (`runtime-local`) has no cloud secret store, so `secretRef` resolves against a **dev-only** source, in order: (1) a gitignored **`.env.local`**, (2) the OS keychain, (3) an interactive prompt (skipped in CI; CI uses `.env.local` or stubbed providers). Dev secrets are **clearly marked non-production**, audited as `secret.Accessed { camp: "local", source: "dev" }`, and never satisfy a production `can-deploy`. Tests prefer `stub()`ed providers ([Plan 23](./generated-stack.md#plan-23)) so unit runs need no real secret at all.

**Availability & failure modes.** If a Camp's secret store is unreachable, `secretRef` resolution **fails fast after a bounded retry** (a small capped-backoff budget), emits `secret.Unavailable`, and surfaces a typed error the step can handle — it does **not** silently fall back to a static value. A short, bounded in-process cache (above) may serve a recently-fetched value within its TTL; beyond that, the call fails rather than serve stale/unknown credentials. Treat secret-store availability as a dependency in the SLO budget ([Plan 5](./reliability-observability-cost.md#plan-05)).

**App-facing crypto (keys the app never holds).** The secretless model extends to **cryptography**: a `crypto(name)` resource (`hobo:crypto` port, above / [Plan 20](./wasm-runtime-wit.md#plan-20)) offers `encrypt`/`decrypt` (envelope) + `sign`/`verify` where the **key material never enters app code** — the app holds a brokered key *handle* (via Identity, [Plan 6](./ai-native-agent-auth.md#plan-06)), and the operation runs against a per-Camp **KMS / Key Vault / Cloud KMS / in-boundary HSM** behind the port (air-gap: in-boundary KMS, [ADR-0027](./adr/02-identity-security.md#adr-0027)/[ADR-0036](./adr/07-portability-extensibility.md#adr-0036)). Same secretless guarantee as tokens: nothing key-shaped at rest in the app. (Closes the Dapr-crypto parity item, [gap-analysis G9](../competitors/gap-analysis.md).)

**Why this is safe.**
- **Nothing to steal by default** — the common case (bound resources) uses brokered tokens, so there is no secret at rest ([ADR-0008](./adr/index.md)).
- **Blast radius is bounded** — tokens are short-lived + resource-scoped; the static fallback is TTL'd, rotated, and audited ([ADR-0023](./adr/02-identity-security.md#adr-0023)).
- **Portable** — the Bindle declares needs; sources resolve under the **Yard provider** at the attached Camp; **swapping clouds re-homes Camps via Trails / Yard attachment**, never an app edit or Camp-owned provider pin.

Config notes: fetched secrets are held in a short, bounded in-process cache (TTL above) and each cache miss re-audits; non-secret config supports live reload, pushed from the Camp's Deployment Set; each provider's `secrets` port adapter resolves per-Camp sourcing, and providers without a native secrets port use a shim adapter behind the same port.

### The Hobo Code DSL (configuration + code, one surface)

> **One surface for config *and* code, with two entry levels.** Hobo Code is HoBo's human-readable DSL that declares **Yards, Camps, Bindles** and their resources/wiring **and** the workflow/step/agent behavior that runs in them — built to be **optimal for AI generation, training, and optimization** as well as human authoring. The programmable surface is **WIT/WASM**; any Component-Model language can author Bindles and providers, and TypeScript is just the **first reference implementation** ([ADR-0069](./adr/01-architecture-core.md#adr-0069)). Hobo Code is a *sibling* authoring front-end alongside that TypeScript reference: both lower to the same **Manifest IR** (above) + runtime constructs ([ADR-0049](./adr/01-architecture-core.md#adr-0049)).

**Two-level authoring model.** Authors enter at whichever level fits; both compile to the same artifacts ([ADR-0049](./adr/01-architecture-core.md#adr-0049)).
- **Level 1 — declarative DSL/config, no code.** A first-class no-code entry point: the small, regular declarative surface declares **scope/topology** (`Yard`/`Camp`/`Bindle` + resources + `.allow()` + `bind` wiring) and **behavior shape** (`workflow`/`step`/`actor`/`saga`/`agent`, `"use query"`/`"use training"` methods) **without writing code**. The same declarative path drives **init, spec, and code-generation** — declarations alone produce a deployable Bindle.
- **Level 2 — generated SDK code stubs (intermediary artifacts).** The DSL **generates typed `service`/`workflow`/`step`/`actor` stubs** with `.allow()` pre-wired and the `bind` graph stitched. Stubs are the seam where hand-written code lands: the author fills the bodies while the declarative source stays authoritative for topology.

**Flow: declarative DSL/config → generated SDK stubs → code.** The no-code declarative path is the front door; it emits SDK stubs, and developers extend the stubs with behavior. A pure no-code stack is valid end-to-end; a code-heavy stack starts from the same declarations and grows.

Ties to the rest of the model:
- **Stubs via codegen** ([ADR-0037](./adr/01-architecture-core.md#adr-0037)) — the same deterministic, checked-in `_generated/` discipline and `--check` drift gate, so DSL → stub output is reviewable and reproducible.
- **Placement via deterministic Matching** ([ADR-0033](./adr/01-architecture-core.md#adr-0033)) — the DSL declares the resource graph; Matching resolves it to Camps.
- **Both levels lower to the one Manifest IR** (above) — no new runtime semantics; the scope model is `Yard ⊃ Camp ⊃ Bindle` ([ADR-0026](./adr/01-architecture-core.md#adr-0026)).

**Why a DSL.** HoBo is **AI-native** ([Plan 6](./ai-native-agent-auth.md#plan-06)): agents and the generation pipeline generate, repair, and optimize HoBo artifacts (the generation pipeline, [Plan 23](./generated-stack.md#plan-23); `"use training"`, [Plan 23](./generated-stack.md#plan-23)). TypeScript + IfC ([Plan 2](./sdk-api.md#plan-02)) is ideal for humans with an editor and a type-checker but a noisy generation/training target: large grammar, host imports, collection-time side-effects, an AST that is hard to diff/score. Hobo Code is **small, regular, declarative-first, and low-ambiguity** — exactly what makes a surface cheap to generate correctly, cheap to *train on*, and cheap to *optimize* against a reward signal. It also forces no author through code when a declaration would do (Level 1).

**Design properties.**
- **Small, regular grammar** with a **stable, canonical AST** — one obvious way to express a thing, so generated programs are diffable and scoreable.
- **Declarative-first + deterministic** — no host imports or collection-time side-effects; the same source always lowers to the same IR (replay-safe, [Plan 11](./data-plane.md#plan-11)).
- **Schema-aware & self-describing** — the grammar carries enough structure that a model (and a linter) can complete/repair it locally; errors are machine-actionable (like `deployment.PlanRejected`).
- **Token-efficient** — terse but readable, so generation/training context stays small.
- **Round-trippable with TypeScript** — TS↔Hobo Code is mechanically convertible (both are views over the same IR/AST), so teams mix surfaces and the generation pipeline emits either.

**Where it sits (front-end over the shared IR).**
```mermaid
flowchart LR
  subgraph FE["Authoring front-ends"]
    TS["TypeScript SDK + IfC<br/>(Plan 2 / Plan 21)"]
    HC["Hobo Code DSL<br/>(L1 declarative + L2 stubs)"]
  end
  HC --> STUB["generated SDK stubs<br/>(codegen, ADR-0037)"]
  STUB --> AST["canonical AST"]
  TS --> AST
  AST --> IR["Manifest IR<br/>(Plan 21)"]
  IR --> PLAN["Planner / Matching<br/>(Plan 25 / ADR-0033)"]
  PLAN --> DEPLOY["Deploy to Yards / Camps"]
  FORGE["generation pipeline + training-engine<br/>(Plan 33 / Plan 23)"] -.generate / optimize.-> HC
  IR -.codegen types.-> TS
```

Relationship to existing concepts:
- **TypeScript SDK ([Plan 2](./sdk-api.md#plan-02))** — the **first reference implementation** of the WIT/WASM authoring surface, not a required language ([ADR-0069](./adr/01-architecture-core.md#adr-0069)); a peer front-end with identical semantics, different ergonomics, and any Component-Model language can stand beside it. Codegen ([ADR-0037](./adr/01-architecture-core.md#adr-0037)) and conformance ([Plan 9](./generated-stack.md#plan-09)) apply to both.
- **The generation pipeline, the Crew & `"use training"` ([Plan 23](./generated-stack.md#plan-23)/[Plan 40](./operators-sre.md#plan-40)/[Plan 23](./generated-stack.md#plan-23))** — the primary *consumers/producers* of Hobo Code: it is the **token-efficient IR for codegen + platform config** that the generated stack ([Plan 23](./generated-stack.md#plan-23)) emits and the **Platform Engineer operator** ([Plan 40](./operators-sre.md#plan-40)) authors. A compact, regular, low-ambiguity target is what makes generation/repair/optimization tractable and cheap in tokens.
- **Capability Manifest ([Plan 6](./ai-native-agent-auth.md#plan-06))** — a distinct artifact, not to be confused with this DSL: it is the machine-readable auth+capability standard (`/.well-known/capability-manifest/`, WIT `hobo:capability-manifest`).
- **Data plane / projections ([Plan 32](./data-plane.md#plan-32))** — a target for Hobo Code's config half: declaring **projections + schema mappings** (and the WIT-record domain schema, [ADR-0051](./adr/03-data-plane.md#adr-0051)) is exactly the kind of regular, declarative surface the DSL is for.

DSL notes: the config half (Yards/Camps/Bindles + resources + `.allow()` + wiring) and the embedded-code half (workflow/step bodies, compiled to wasm components, [Plan 20](./wasm-runtime-wit.md#plan-20)) are both first-class; the toolchain is a parser, canonicalizing formatter, LSP, and the TS↔Hobo Code transpiler, with the AST as the canonical artifact surfaced as text; the training/optimization interface scores and mutates a generated program's AST via the `training-engine` ([ADR-0025](./adr/03-data-plane.md#adr-0025)); grammar evolution is versioned and existing Bindles migrate via the shared IR + transpiler.
