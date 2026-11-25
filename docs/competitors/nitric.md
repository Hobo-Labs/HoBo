---
type: Competitive Reference
title: "Nitric — Competitor Reference"
description: "- **Tagline:** *\"Build cloud backends that run anywhere, fast.\"*"
tags: [hobo, competitors]
competitor:
  slug: nitric
  name: "Nitric"
  aliases: ["nitrictech"]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, portable-application-models]
  directness: overlapping
  role: "cloud-agnostic infrastructure-from-code framework — authoring analog for typed resource declaration"
  posture: [borrow, benchmark]
  hobo_surface: [authoring, typed-contracts, provider-matching, runtime-portability]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://nitric.io/docs
    - https://github.com/nitrictech/nitric
---

# Nitric — Competitor Reference

> Captured for HoBo competitive analysis. Source: nitric.io/docs, github.com/nitrictech (as researched). This file documents **Nitric's** offering faithfully; the HoBo↔Nitric mapping/parity tracker lives in the [primitive mapping](#primitive-mapping) section below.

## What it is

> Section title kept as the original capture wrote it; this is the contract's "what it is".


- **Tagline:** *"Build cloud backends that run anywhere, fast."*
- **Paradigm:** **Infrastructure from Code (IfC)** — you declare the cloud resources your app needs *inline in application code*; Nitric infers and provisions the infrastructure (and least-privilege IAM) automatically.
- **Mental model:** "Developer In" (start from "what workflow does the developer need?") rather than IaC's "System Out" (start from "what can the platform do?").
- **Promise:** one codebase deploys to AWS, GCP, Azure, Kubernetes, or a single server — even several clouds at once — with no code changes.
- **Target user:** backend developers building serverless/cloud apps who want multi-cloud portability and dev velocity over cloud-specific control.

## Architecture

```
App code (with inline resource declarations + .allow())
  → Nitric SDK (Node / Python / Go / Dart)
  → Nitric Runtime ("the Membrane", gRPC)
  → Provider plugin (Pulumi- or Terraform-based; deploy + runtime layers)
  → AWS / GCP / Azure / Kubernetes / server
```

**Services vs Resources.** *Services* are containerized entry points to your code (API handlers, schedule handlers, subscribers, websocket handlers, batch handlers, websites) — each becomes an independently scaling container. *Resources* are the building blocks services use (apis, kv, buckets, queues, topics, secrets, sql, schedules, websockets, jobs, websites).

**Resource collection.** On `nitric up`, each service runs in a special **resource-collection mode**: SDK calls that declare resources are *captured but not executed*, producing a resource/dependency graph that the provider plugin turns into IaC. This model prevents orphaned infra and code↔IaC drift.

**The Membrane.** A gRPC runtime sits between app code and the provider runtime, exposing service contracts (document/kv, storage, queue, topic, secret, sql). SDKs are thin gRPC clients generated from proto contracts (`github.com/nitrictech/contracts`); this proto boundary is what makes the SDKs language-agnostic and the providers swappable.

**Permissions.** Declared inline via `.allow(...)`; Nitric generates **least-privilege IAM** per cloud automatically.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Resource** | A cloud capability declared inline in application code — a bucket, queue, topic, key-value store, API, schedule |
| **`.allow(verbs)`** | The access declaration that both wires the resource and derives least-privilege IAM |
| **Collection run** | The build-time execution of the application in a special mode, so the resource graph is *inferred by running the code* rather than parsed from files |
| **Provider** | The realization target (AWS, GCP, Azure, Kubernetes, a single server), implemented behind a membrane |
| **Membrane** | The gRPC sidecar that serves the portable resource APIs at runtime |

The mental model is **declare where you use it**. There is no separate infrastructure file: the
resource appears in the module that needs it, `.allow()` states the access, and running the program
in collection mode produces the graph. This is infrastructure-from-code in its purest form, and it is
the model HoBo's authoring surface descends from.

## How it competes with HoBo

Nitric is recorded in [`lineage.md`](../design/lineage.md) as a **pillar** — HoBo's IfC-default
authoring and the `.allow()` least-privilege instinct come from here.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | **Direct, and the source of HoBo's own model** |
| `typed-contracts` | A portable resource catalog realized per provider |
| `provider-matching` | Provider selection at deploy time, chosen by configuration rather than scored |
| `runtime-portability` | The membrane serves the same APIs everywhere |

The divergence is the substrate and the decision: Nitric's portability runs through a gRPC sidecar
and a configured provider; HoBo's runs through WIT ports and a scored, recorded match.

## Feature surface

### Resource catalog

Every resource/primitive, its SDK surface, permission verbs, and cloud mappings. Snippets are Node `@nitric/sdk`.

| Resource | Declaration | `.allow()` verbs | AWS | GCP | Azure |
|---|---|---|---|---|---|
| **API** (HTTP) | `api('name')` | (route-level security) | API Gateway + Lambda | Cloud Run | Container Apps |
| **KV store** | `kv('name')` | `get`,`set`,`delete` | DynamoDB | Firestore | Cosmos DB / Table |
| **Bucket** | `bucket('name')` | `read`,`write`,`delete` | S3 | Cloud Storage | Blob Storage |
| **Queue** (pull) | `queue('name')` | `enqueue`,`dequeue` | SQS | Cloud Tasks | Service Bus Queue |
| **Topic** (push) | `topic('name')` | `publish`,`subscribe` | SNS / EventBridge | Pub/Sub | Event Grid / SB Topic |
| **Secret** | `secret('name')` | `put`,`access` | Secrets Manager | Secret Manager | Key Vault |
| **SQL** (preview) | `sql('name')` | (connection string) | RDS Postgres | Cloud SQL PG | Azure DB for PG |
| **Schedule** | `schedule('name')` | n/a | EventBridge | Cloud Scheduler | Timer Trigger |
| **WebSocket** | `websocket('name')` | n/a | API GW WebSocket | Firestore+PubSub | Web PubSub |
| **Batch job** | `job('name')` | `submit` | AWS Batch | Cloud Batch | Azure Batch |
| **Website** | `websites:` (yaml) | n/a | CloudFront + S3 | Cloud Storage + CDN | Front Door + Blob |

```javascript
// API — methods get/post/put/delete/patch/options/head/all; middleware via myApi.use(fn)
import { api } from '@nitric/sdk'
const myApi = api('main')
myApi.get('/users/:id', async (ctx) => { ctx.res.json({ id: ctx.req.params.id }) })
// ctx.req: params, query, headers, json(), text(), body ; ctx.res: status, headers, json(), text(), send()
// route security via OIDC rules (see Security & IAM below)

// KV store
import { kv } from '@nitric/sdk'
const countries = kv('countries').allow('get','set','delete')
await countries.set('USA', { population: 330_000_000 })
const c = await countries.get('USA')
await countries.delete('USA')
for await (const key of countries.keys('US')) { /* prefix scan */ }

// Bucket (storage)
import { bucket } from '@nitric/sdk'
const profiles = bucket('profiles').allow('read','write','delete')
await profiles.file('u/john.png').write(bytes)         // max 4MB direct write
const b = await profiles.file('u/john.png').read()
const url = await profiles.file('u/john.png').getDownloadUrl({ expiry: 3600 })  // presigned
profiles.on('write', '/u', async (ctx) => { /* bucket notification */ })

// Queue (pull-based)
import { queue } from '@nitric/sdk'
const q = queue('transactions').allow('enqueue','dequeue')
await q.enqueue({ amount: 100 })                  // single or array (batch)
const tasks = await q.dequeue(10)
for (const t of tasks) { /* t.payload */ await t.complete() }

// Topic (push-based pub/sub)
import { topic } from '@nitric/sdk'
const created = topic('user-created').allow('publish')
await created.publish({ email })
created.subscribe(async (ctx) => { /* ctx.req.json() */ })   // at-least-once, may duplicate

// Secret (versioned)
import { secret } from '@nitric/sdk'
const apiKey = secret('api-key').allow('put','access')
const v = await apiKey.put('value')
const value = (await apiKey.latest().access()).asString()

// SQL (preview)
import { sql } from '@nitric/sdk'
const db = sql('app')
const conn = await db.connectionString()           // use with pg/SQLAlchemy/etc.
// migrations/<db>/<version>_<name>.up.sql auto-applied; or dockerfile:// for complex

// Schedule
import { schedule } from '@nitric/sdk'
schedule('daily').every('24 hours', async () => {})
schedule('cleanup').cron('0 1 1 * *', async () => {})    // 5-field cron; per-stack timezone (AWS/GCP)

// WebSocket — typically paired with a kv() to track connections for broadcast
import { websocket } from '@nitric/sdk'
const chat = websocket('chat')
chat.on('connect', async (ctx) => { /* ctx.req.connectionId */ })
chat.on('message', async (ctx) => { await chat.send(ctx.req.connectionId, { reply: 'hi' }) })
chat.on('disconnect', async (ctx) => {})

// Batch / Job (AI/ML/HPC)
import { job } from '@nitric/sdk'
const analyze = job('analyze')
analyze.handler(async (ctx) => { /* heavy compute */ }, { cpus: 4, memory: 16384, gpus: 1 })
const submit = job('analyze').allow('submit'); await submit.submit({ imageUrl })
```

```yaml
# Website (static) — nitric.yaml
websites:
  - basedir: ./dist
    path: /
    index: index.html
    build: { command: npm run build, dir: dist }
    dev:   { command: npm run dev, url: http://localhost:5173 }
```

### Security & IAM

Permissions are declared at the point of use via `.allow(...)`; from these Nitric generates **least-privilege** policies per cloud automatically (AWS IAM roles + policies, GCP IAM bindings, Azure role assignments). No manual IAM authoring; access is explicit in code, eliminating overly broad grants — a headline differentiator vs raw IaC.

```javascript
const data   = bucket('data').allow('read','write')
const tasks  = queue('tasks').allow('enqueue')
const apiKey = secret('api-key').allow('access')
```

API authentication uses OIDC rules, compatible with providers like Auth0, Cognito, FusionAuth:

```javascript
const rule = oidcRule({
  name: 'default',
  audiences: ['https://myapp.example.com'],
  issuer: 'https://auth-provider.example.com',
})
const secure = api('main', { security: [rule()] })
secure.get('/protected', securityRule('default'), async (ctx) => { /* authenticated */ })
```

Custom auth middleware is also supported:

```javascript
async function validateApiKey(ctx, next) {
  if (ctx.req.headers['x-api-key'] !== process.env.API_KEY) { ctx.res.status = 401; return ctx }
  return await next(ctx)
}
api('main').use(validateApiKey)
```

Note: security rules are **not enforced in local dev** (`nitric start`) — you must deploy to a cloud to test them.

### Providers, runtime contract & SDKs

A Nitric **provider** is a single compiled binary implementing two layers:

1. **Deployment layer** (Go) — translates the collected resource spec into cloud infra using **Pulumi** or **Terraform (CDKTF)**. Interface (illustrative):
   ```go
   type NitricPulumiProvider interface {
     Init(ctx *pulumi.Context) error
     Pre() error
     Config() map[string]interface{}
     Order() []string
     Api(...) error;  Bucket(...) error;  Service(...) error
     Topic(...) error; Queue(...) error;  /* ... per resource ... */
     Result() error
   }
   ```
2. **Runtime layer** (gRPC) — implements Nitric's proto service contracts; executes at runtime, translating SDK calls into cloud API calls.

Pre-built providers ship in two flavors, selected/swapped purely in **stack config** (`provider: aws`) with no code change:
- **Pulumi-based** (direct deploy): `aws`, `gcp`, `azure`.
- **Terraform-based** (emit CDKTF to `cdktf.out/` for review): `aws`, `gcp`, `azure`.

**Custom providers** extend Nitric two ways: *extend* an existing provider — replace a resource's implementation (e.g. S3 → DigitalOcean Spaces via S3-compatible API), add pre/post hooks, inject config, referenced as `provider: custom/extension@0.0.1`; or *build new* for other clouds (DigitalOcean, Linode…), on-prem, Kubernetes, or specialized needs. Project structure and install:

```
provider-repo/
  cmd/deploy/   cmd/runtime/   deploy/   runtime/   Makefile   main.go
# compiled to a single binary placed at:
~/.nitric/providers/custom/<name>@<version>
```

**The runtime contract ("the Membrane", gRPC + protobuf).** Contracts live in `github.com/nitrictech/contracts`. Representative services/ops:
- **Document/KV:** `Get`, `Set`, `Delete`, `Query`
- **Storage:** `Read`, `Write`, `Delete`, `ListFiles`, `DownloadUrl`, `UploadUrl`
- **Queue:** `Enqueue`, `Dequeue`, `Complete`
- **Topic:** `Publish`, `Subscribe`
- **Secrets:** `Put`, `Access`, `AccessVersion`
- **SQL:** `ConnectionString`

**Language SDKs** (over gRPC) — each is resource constructors + `.allow()` + handler registration + a gRPC client generated from the proto contracts:

| Language | Status | Package |
|---|---|---|
| Node.js | Full | `@nitric/sdk` |
| Python | Full | `nitric` |
| Go | Full | `github.com/nitrictech/go-sdk` |
| Dart | Experimental | `nitric` |
| C#/.NET, JVM | Experimental | `nitrictech/dotnet-sdk`, `nitrictech/jvm-sdk` |

### CLI, configuration & local dev

```bash
brew install nitrictech/tap/nitric   # macOS; Scoop on Windows; binaries otherwise

nitric new [project]        # scaffold from template
nitric stack new            # create a stack (deploy target) file
nitric start                # local: emulate resources + dashboard (hot reload)
nitric run                  # local: build & run each service in Docker (prod-like)
nitric build                # build containers, no deploy
nitric spec                 # print the collected resource specification
nitric up   [-s stack]      # build → collect resources → deploy
nitric down [-s stack]      # tear down (confirm)
nitric stack list | new
nitric version | help | debug | completion
# --ci flag: no styling, auto-confirm
```

**Configuration.** `nitric.yaml` (project) defines `services` (match glob, runtime, start cmd), `batch-services`, `websites`, and custom `runtimes` (Dockerfile/context/args). Stack files `nitric.<stack>.yaml` (per target/env) set `provider`, `region`, and provider-specific config (profile/project/subscription) — one per environment, swappable. `.env`/secrets are included at deploy; consumed in-code via env vars or `secret()`.

**`nitric start`** runs the local Nitric server (membrane), launches each service via its `start` command from `nitric.yaml`, hosts APIs on dynamic ports, hot-reloads on change, and opens the **Local Dashboard** (default `http://localhost:49152`). **`nitric run`** containerizes each service (one container per service) for a production-like local run. The dashboard offers architecture visualization, an HTTP client to test APIs, batch-job observation + manual triggers, a SQL DB viewer + query runner, schedule trigger buttons, bucket file management, topic message publish + inspect, secret management, websocket connection debugging, and website preview.

**Deployment flow (`nitric up`).** (1) Build — each service → container image (autodetected runtime, standard or custom Dockerfile). (2) Resource collection — run each service in collection mode; capture (don't execute) all resource/`.allow()` declarations → resource spec/graph. (3) Provider invocation — pass spec to the provider plugin; Pulumi deploys directly, Terraform emits CDKTF. (4) Deploy — infra created/updated. (5) Output — URLs/endpoints returned.

**Typical loop.** `nitric start` → iterate → test locally (OIDC/security rules are NOT enforced locally) → `nitric stack new` (choose provider/region/credentials) → `nitric up -s <stack>` (build, collect, deploy; URLs returned) → iterate and re-run → `nitric down -s <stack>` to remove.

**Testing strategy** (as documented): *Unit* — separate resources from handlers, mock resources (`jest.spyOn`), test handlers in isolation. *Integration* — `nitric start` + an HTTP client (e.g. supertest) against local APIs; verify side effects. *Cloud* — deploy a stack and point the same tests at deployed URLs (`process.env.API_URL`).

### Escape hatches

Direct cloud SDK access for anything outside the abstracted services; provider extension; and custom providers for new clouds or backends.

### Commercial

**Nitric Deploy** (formerly "Suga") — managed deployments (sub-10s), visual infra, observability; for teams who don't want to self-manage providers.

## Where Nitric is stronger

> Shipped, evidenced capability only.


### Headline differentiators

1. **Infrastructure from Code (IfC)** — resources declared inline where used; no separate IaC files; resource graph inferred by running code in collection mode.
2. **Automatic least-privilege IAM** from `.allow()` declarations.
3. **True multi-cloud portability** — one codebase → AWS/GCP/Azure/K8s/server, no cloud-specific code paths.
4. **Multi-language via a gRPC membrane** — identical SDK surface across Node/Python/Go/Dart; new languages by compiling proto contracts.
5. **Integrated local dev** — full local emulation + dashboard, no LocalStack.
6. **Resource-collection model** — prevents orphaned infra and code↔IaC drift.
7. **Escape hatches** — direct cloud SDK, provider extension, custom providers.

### How Nitric positions vs others (their framing)

- **vs Terraform:** developer-centric + auto-IAM + multi-cloud without per-provider code (Terraform is IaC-first, explicit, per-provider).
- **vs Pulumi:** higher-level abstractions + built-in local dev + true portability (Pulumi is lower-level infra control).
- **vs AWS SAM:** multi-cloud + multi-language + auto-IAM (SAM is AWS-only, YAML).
- **vs Serverless Framework:** real cloud-agnostic abstraction + integrated local dev (SF is AWS-centric, plugin-driven).
- **vs SST:** cloud-agnostic + provider-agnostic + extensible (SST is AWS + Pulumi, opinionated full-stack AWS).
- **vs Encore:** broader resource set + multiple clouds (Encore is more opinionated full-stack).

### Gaps / limitations (opportunities for HoBo)

- SQL databases in **preview** (hourly pricing, not serverless); enable via config.
- Custom domains **AWS-only**.
- Security rules **not enforced locally**.
- Bounded to abstracted services — anything else needs the cloud SDK (some coupling).
- Custom-provider authoring requires **Go**; "not easy to iterate on" (the user's own words).
- No first-class **actor/durable-workflow/event-sourcing** model.
- No **agent-native** story (agent identity, agent token brokering, MCP control surface).
- No **WASM/WASI** runtime / polyglot-via-components story.
- No **AI-generated providers/implementations**; provider breadth is human-driven.

## Primitive mapping

<a id="hobo-mapping"></a>

> For every Nitric feature, the HoBo equivalent and the design doc that owns it. ✅ = designed at parity · ➕ = HoBo goes further · 🔜 = planned, see iteration hooks. HoBo design lives in [`../../design/`](../design/index.md).

### Core model

| Nitric | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Infrastructure from Code (run-to-collect) | **IfC-default**: resources declared inline + `.allow()`, collected by running the wasm component in resource-collection mode → manifest IR | ✅ | [02](../design/sdk-api.md#plan-02), [22](../design/authoring-resources-wiring.md#plan-21) |
| Services (containerized entry points) | **Services = wasm/wasi components by default** (OCI container fallback) | ➕ | [20](../design/wasm-runtime-wit.md#plan-20) |
| Resources (building blocks) | HoBo resources = **WIT ports** with equivalence classes | ✅ | [21](../design/authoring-resources-wiring.md#plan-21) |
| The Membrane (**gRPC** runtime contract) | **wRPC membrane** (wasmCloud's WIT-native RPC) over the WIT/wasm host boundary: component imports → host routes to linked provider; wire generated from WIT, no bespoke proto; same contract drives local/cross-process/lattice | ➕ | [20](../design/wasm-runtime-wit.md#plan-20), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069) |
| Resource spec | **Manifest IR** (Nitric spec ∪ Aspire manifest) consumed by the Planner | ➕ | [22](../design/authoring-resources-wiring.md#plan-21) |

### Resource catalog (full parity target)

| Nitric resource | HoBo port (WIT interface) | Status |
|---|---|---|
| `api` | `hobo:http` / `wasi:http` | ✅ |
| `kv` | `wasi:keyvalue` | ✅ |
| `bucket` (+ events, presigned) | `wasi:blobstore` (+ `hobo:blob-events`) | ✅ |
| `queue` (pull) | `hobo:queue` (`wasi:messaging` profile) | ✅ |
| `topic` (push pub/sub) | `wasi:messaging` | ✅ |
| `secret` (versioned) | `wasi:config/store` + `hobo:secrets` (put → version, access latest\|pinned) ([Plan 20](../design/wasm-runtime-wit.md#plan-20), [ADR-0113](../design/adr/02-identity-security.md#adr-0113)) | ✅ |
| `sql` | `hobo:data/relational` (realizable over draft `wasi:sql`) ([ADR-0112](../design/adr/03-data-plane.md#adr-0112)) | ✅ |
| `schedule` (cron/interval) | `hobo:scheduler` (control-plane `cron`) | ✅ |
| `websocket` | `hobo:websocket` | ✅ |
| `job` (batch, cpu/mem/gpu) | `hobo:job` (+ IaaS `vm`/`microVm`) | ✅ |
| `website` (static/SSR) | `web()` resource | ✅ |

All resources detailed with `.allow()` verbs + cross-cloud equivalence in [21](../design/authoring-resources-wiring.md#plan-21).

### Permissions, security, providers

| Nitric | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| `.allow(verbs)` → least-privilege IAM | `.allow(verbs)` drives **IAM + wasm capability grants (links) + agent token scope** (one declaration, three effects) | ➕ | [21](../design/authoring-resources-wiring.md#plan-21), [06](../design/ai-native-agent-auth.md#plan-06) |
| OIDC API auth | Per-route **OIDC/JWT security rules** + `api.use()` middleware on `hobo:http`; enforced in **`hobo dev`** and at gateway ([route-level API security](../design/authoring-resources-wiring.md#route-level-api-security)) | ➕ | [21](../design/authoring-resources-wiring.md#route-level-api-security), [06](../design/ai-native-agent-auth.md#plan-06), [ADR-0114](../design/adr/02-identity-security.md#adr-0114) |
| `oidcRule` / `securityRule` per route + `api.use()` middleware | Named security rules (api default + per-route override + `public` opt-out) + ordered middleware chain; same manifest IR in dev and prod | ➕ | [21](../design/authoring-resources-wiring.md#route-level-api-security) |
| Pulumi/Terraform providers | `iac-pulumi` (primary) + Crossplane/OpenTofu adapters | ✅ | [03](../design/control-plane.md#plan-04) |
| Provider = deploy + runtime layers (**Go plugins**) | **Provider = WIT-component** that *exports* the building-block interfaces (deploy realize() + runtime WIT impl + link); the contract **is** the WIT world, no Go/TS plugin SDK | ➕ | [03](../design/control-plane.md#plan-04), [20](../design/wasm-runtime-wit.md#plan-20), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069) |
| Custom providers (**Go-only** plugins) | Provider authoring in **any wasm language** (code against WIT, not a plugin API) + `@hobo/conformance` gate; **auto-generatable** | ➕ | [03](../design/control-plane.md#plan-04), [23](../design/generated-stack.md#plan-23) |
| Stack files (per-target) | `hobo.config.ts` + Camps (per-env) | ✅ | [02](../design/sdk-api.md#plan-02) |

### CLI, local dev, deployment

| Nitric | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| `nitric start` (emulate + dashboard) | `hobo dev` on `runtime-local` + dashboard | ✅ | [15](../design/developer-experience.md#plan-07), [07](../design/developer-experience.md#plan-07) |
| `nitric run` (containers) | `hobo dev` (wasm host; OCI fallback via runtime provider) | ✅ | [15](../design/developer-experience.md#plan-07) |
| `nitric up/down/spec/build` | `hobo up/down/collect/plan/build` | ✅ | [15](../design/developer-experience.md#plan-07) |
| Local dashboard (test APIs, view kv/sql, trigger schedules, etc.) | HoBo dashboard + **run inspector / replay / link & trace views** | ➕ | [07](../design/developer-experience.md#plan-07), [14](../design/reliability-observability-cost.md#plan-05) |
| Multi-cloud, deploy to many at once | mapping rules: whole-app / per-tier / per-boundary | ✅ | [02](../design/sdk-api.md#plan-02), [03](../design/control-plane.md#plan-04) |

### Where HoBo deliberately exceeds Nitric (net-new)

| Capability | HoBo doc |
|---|---|
| **WASM/WASI-default polyglot runtime** (any language → component; capability security) | [20](../design/wasm-runtime-wit.md#plan-20) |
| **wRPC membrane + WIT-component providers + thin SDK** (same building-block set as Nitric's gRPC + Go-plugin shape, realized on the Component Model; SDK is typed sugar with no cloud logic; deny-by-default by linking) | [ADR-0069](../design/adr/01-architecture-core.md#adr-0069) |
| **Dev auth bypass via integrated contract testing** (`hobo dev` satisfies the `auth` contract with a fixture principal; same contract gates `can-deploy`, so dev can't drift from prod — vs Nitric's OIDC rules not enforced locally) | [ADR-0070](../design/adr/02-identity-security.md#adr-0070) |
| **Actors + durable workflows + choreography sagas** over a replayable event store | [02](../design/sdk-api.md#plan-02), [11](../design/data-plane.md#plan-11) |
| **Agents as first-class principals** + Capability Manifest + MCP control surface | [06](../design/ai-native-agent-auth.md#plan-06) |
| **AI-generated providers AND implementations**; stub → implement → trace → auto-evolve → live-fix (gated) | [23](../design/generated-stack.md#plan-23) |
| **Aspire-style wiring + manifest IR** for any component/container | [22](../design/authoring-resources-wiring.md#plan-21) |
| **Reliability/HA, security/multi-tenancy, networking, cost/FinOps** as designed concerns | [05](../design/reliability-observability-cost.md#plan-05), [12](../design/security-networking.md#plan-12), [13](../design/security-networking.md#plan-12), [16](../design/reliability-observability-cost.md#plan-05) |

### Open parity items (iteration hooks)

- Bucket-event + presigned-URL semantics as a HoBo WIT extension (`hobo:blob-events`).
- Per-language IfC collection fidelity (run-to-collect vs static analysis).
- ~~WebSocket port WIT shape (no standard `wasi:websocket` yet).~~ ✅ **RESOLVED** — preview `wasi:websocket` + `hobo:websocket` extension ([ADR-0075](../design/adr/07-portability-extensibility.md#adr-0075), [Plan 20](../design/wasm-runtime-wit.md#plan-20)).
- ~~`sql` migrations workflow parity (Nitric's `migrations/<db>/*.up.sql`).~~ ✅ **RESOLVED** — declarative desired-schema + auto-diff ([Plan 32](../design/data-plane.md#plan-32), [ADR-0032](../design/adr/03-data-plane.md#adr-0032)).

## Adversarial critique

- **The membrane is a runtime dependency on every request path.** A gRPC sidecar serving the resource
  APIs is a latency, deployment and failure-mode cost that a direct SDK call does not have.
- **Collection-by-execution is clever and fragile.** Inferring the graph by running the program means
  the graph depends on code paths executing; conditional or dynamically-constructed resources are
  where this model gets surprising.
- **Portability is bounded by the lowest common denominator.** A resource catalog that must map onto
  AWS, GCP, Azure and Kubernetes can only expose what all of them share, and the escape hatches
  (direct cloud SDK, custom providers) are where real applications end up.
- **Documented maturity gaps** — SQL databases in preview with hourly rather than serverless pricing,
  custom domains AWS-only, security rules not enforced locally — are the kind of edges that decide
  production adoption.
- **Local rules divergence is a real hazard**: least-privilege that is enforced in the cloud and not
  locally means the failure appears after deploy.
- **Small ecosystem** relative to Terraform or Pulumi, with correspondingly fewer people who have hit
  and solved the same problem.
- **Provider choice is configuration, not a decision.** Nothing scores or records why a given
  provider was appropriate.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`; **proof** =
draft/proof material; **design-only** = design intent. See the
[live provider matrix](../design/live-provider-matrix.md) for HoBo's coverage caveats.

- **Portability is scored and reported** (*implemented*, ADR-0144). Nitric asserts portability; HoBo
  measures it and declares where thin adapters leak.
- **Provider selection is a recorded decision** (*implemented*, `match.Decided`).
- **WIT ports rather than a gRPC membrane** (*implemented*, ADR-0031). Capability links are resolved
  at the component boundary rather than served by a sidecar on the request path.
- **Event-sourced control plane with replay** (*implemented*, ADR-0135).
- **Fail-closed residency** (*implemented*, ADR-0146).
- **Contract effects and resilience profiles** (*implemented*, ADR-0136).
- **Honest caveat.** Nitric ships multi-cloud deployment today across a real resource catalog; HoBo's
  default Pulumi path is an in-memory stand-in. The borrowed idea is proven by Nitric, not by HoBo.

## Better-together / integration posture

- **Borrow** — already done and recorded in [`lineage.md`](../design/lineage.md): the IfC-default
  authoring model and `.allow()` least-privilege. This capture reaffirms both and adds a third worth
  considering: **inferring the graph by running the program** is a genuinely different collection
  strategy from parsing a manifest, with real trade-offs on both sides.
- **Benchmark** on multi-cloud resource coverage and on how little ceremony a first deploy needs.
- Not an adopt, provider, render or displace target.

## Threats and lessons

1. **HoBo's authoring model has a working reference implementation that is not HoBo.** Nitric proves
   the ergonomic; HoBo's argument must be what happens after the declaration — scored placement,
   recorded decisions, measured portability.
2. **A sidecar is the pragmatic portability mechanism and the reason to prefer WIT.** Nitric pays a
   per-request cost for portability; HoBo pays a compile-time one. That trade should be stated
   explicitly rather than assumed.
3. **`.allow()` is the best single ergonomic in this cohort** — one declaration producing wiring and
   least-privilege together — and HoBo's version must not be more ceremonious.
4. **Preview-quality edges decide adoption.** Databases in preview and AWS-only domains are exactly
   the details that stop a production migration, and they are worth watching in HoBo's own matrix.

## Sources

- [nitric.io/docs](https://nitric.io/docs) — resources, `.allow()`, collection, providers, membrane
- [nitrictech/nitric](https://github.com/nitrictech/nitric) — source and provider implementations
- HoBo-side: [`design/lineage.md`](../design/lineage.md) records Nitric as a pillar influence

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current resource-catalog maturity and provider coverage were not
re-verified in this pass and are not asserted.
