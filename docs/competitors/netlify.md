---
type: Competitive Reference
title: "Netlify — competitor reference"
description: "Netlify is a **frontend cloud / composable-web platform** — a hosted, Git-driven pipeline that builds your frontend on every push, deploys it to a **global edge network (100+ locations)**, and layers on serverless **Functions** (AWS L"
tags: [hobo, competitors]
competitor:
  slug: netlify
  name: "Netlify"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms]
  directness: overlapping
  role: "composable-web platform (Functions/Edge, Blobs, Netlify DB) — frontend PaaS benchmark"
  posture: [benchmark, provider-target]
  hobo_surface: [delivery, environments]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.netlify.com/
    - https://www.netlify.com/
---

# Netlify — competitor reference

> A faithful, detailed capture of **Netlify** for HoBo competitive analysis. Netlify is a **shipping Jamstack / composable-web leader** — the vendor that coined "Jamstack," with a mature Git→build→edge pipeline, polished Deploy Previews, and a real global edge network — where HoBo is still **design-phase**. The overlap is narrow but real: Netlify's frontend hosting, Functions, Edge Functions, Blobs, and Netlify DB map onto HoBo catalog ports, and Netlify's 2025 **Agent Runners** move onto the same AI-native turf. But Netlify is **frontend/composable-web-centric on its own single-vendor cloud**; HoBo is **backend/infra-control-plane, multi-cloud, wasm-default, self-hostable**. Sources: [netlify.com](https://www.netlify.com/) · [docs.netlify.com](https://docs.netlify.com/) · [netlify.com/platform](https://www.netlify.com/platform/) · [edge-functions API](https://docs.netlify.com/build/edge-functions/api/) · [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) · [Netlify DB](https://docs.netlify.com/build/data-and-storage/netlify-database/) · [Agent Runners](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/) · [pricing](https://www.netlify.com/pricing/). **Proprietary SaaS** (no self-host / no BYO-cloud); **credit-based** usage-metered billing. Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Netlify is a **frontend cloud / composable-web platform** — a hosted, Git-driven pipeline that builds your frontend on every push, deploys it to a **global edge network (100+ locations)**, and layers on serverless **Functions** (AWS Lambda; JS/TS/Go), **Edge Functions** (Deno), and first-party primitives (**Blobs**, **Netlify DB** — Neon Postgres, **Forms**, **Identity**, **Redirects**). Every push to a connected repo fires an automatic build + deploy; **every pull request gets its own unique preview URL** — a live staging environment with no manual setup. HTTPS, DDoS protection, and auto-scaling are on by default.

Netlify **coined "Jamstack"** and now positions around the **Composable Web Platform**, three products: **Netlify Core** (the frontend cloud — build/deploy/edge/functions), **Netlify Connect** (a GraphQL **data-unification** layer over your CMS/commerce/other sources), and **Netlify Create** (a visual editor). Its thesis is *composable architecture* — assemble a site from decoupled best-of-breed services behind a unified frontend and data layer, deployed and previewed as one.

Unlike the infrastructure-from-code analogs (Encore, Nitric) that provision into **your** AWS/GCP, **Netlify is its own single-vendor cloud**: you do not bring a cloud account, and there is **no self-host**. That is the deepest structural contrast with HoBo. In 2025 Netlify pivoted hard toward AI — **Agent Runners** (run Claude Code / OpenAI Codex / Google Gemini against a live project from the dashboard), an **AI Gateway** (beta), and Netlify DB explicitly framed "for AI-native development" — and moved billing to a **credit-based** usage model that meters deploys, bandwidth, compute, and requests.

| Dimension | Netlify |
|---|---|
| Positioning | **Frontend cloud / Composable Web Platform** (Jamstack originator); composable architecture on Netlify's own cloud |
| Authoring / deploy | **Git-driven**: push → auto build → deploy to edge; per-PR **Deploy Previews**; config in `netlify.toml` |
| Compute | **Functions** (serverless, AWS Lambda; **JS / TS / Go**; background + scheduled + streaming) |
| Edge | **Edge Functions** on a **Deno** runtime, running at 100+ edge locations (auth/personalization/geo redirects) |
| Data / storage | **Netlify Blobs** (KV + unstructured/blob store) · **Netlify DB** (managed **Neon** Postgres, auto-provision + branching) |
| Frontend | Static + SSR hosting, framework build detection, global CDN, atomic immutable deploys + instant rollback |
| Data federation | **Netlify Connect** — unify CMS/commerce/etc. into one **GraphQL** API, synced + edge-cached |
| Config | `netlify.toml` (`[build]`, `[[redirects]]`, `[[headers]]`, `[functions]`, `[[edge_functions]]`, `[context.*]`, `[dev]`) |
| CLI / local dev | `netlify` CLI — `dev`, `deploy --prod`, `build`, `init`, `env:*`, `db`, `blobs`, `link` |
| Clouds | **Netlify's own infrastructure only** — no BYO-cloud, no multi-cloud, no self-host |
| AI | **Agent Runners** (Claude Code / Codex / Gemini in-dashboard on live projects) + **AI Gateway** (beta) |
| License / price | **Proprietary SaaS**; **credit-based**: Free $0 (300 credits) · Personal $9/mo (1,000) · Pro $20/mo (3,000, unlimited members) · Enterprise (custom) |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Site** | The deployed unit, built from a repository |
| **Deploy** | An immutable build with its own URL; deploy previews per pull request |
| **Functions / Edge Functions** | Serverless compute at origin and at the edge |
| **Blobs** | Object storage bound to a site |
| **Netlify DB** | Managed relational data attached to a site |
| **Build plugins** | The extension point for the build pipeline |
| **Redirects / headers** | Declarative routing rules committed alongside the site |

The mental model is **the composable web**: the site is the primary object, and compute, storage and
data attach to it. Netlify's original insight — decouple the front end from the backend and deploy it
immutably — is now so thoroughly absorbed that the company competes on the layers it added
afterwards.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | Immutable deploys with per-PR previews and instant rollback |
| `environments` | Deploy previews and branch deploys |
| `authoring` | Convention plus a small declarative configuration file |
| `wiring` | Blobs and Netlify DB attach to a site by reference |

Netlify contests the front-end slice of HoBo's delivery surface and none of its modelling surface.

## Feature surface

### Build & deploy — the Git-driven pipeline

The core loop: connect a Git repo (GitHub/GitLab/Bitbucket/Azure DevOps), and **every push triggers a build + atomic deploy**; **every pull request gets a unique Deploy Preview URL**. Builds run Netlify's build image (framework auto-detection, Build Plugins, the `@netlify/*` build system) and publish an immutable versioned deploy to the CDN, so rollback is instant (repoint to a prior immutable deploy). **Deploy contexts** — `production`, `deploy-preview`, `branch-deploy`, `dev` — let build command/env/publish differ per context.

### `netlify.toml` — file-based config

Config lives in `netlify.toml` at repo root; file settings override UI settings. The real shape (quoted from the docs):

```toml
[build]
  base = "project/"
  publish = "build-output/"
  command = "npm run build"
  [build.environment]
    NODE_VERSION = "20"

[functions]
  directory = "netlify/functions/"
  node_bundler = "esbuild"
  external_node_modules = ["package-1"]
  included_files = ["files/*.md"]

[[edge_functions]]
  path = "/*"
  function = "auth"

[[redirects]]
  from = "/api/*"
  to = "https://backend.example.com/:splat"
  status = 200
  force = true

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"

[context.deploy-preview.environment]
  NOT_PRIVATE_ITEM = "not so secret"

[context.branch-deploy]
  command = "echo branch"

[dev]
  command = "npm start"
  targetPort = 3000
  port = 8888

[[plugins]]
  package = "netlify-plugin-example"
```

Note: `[[redirects]]` and `[[headers]]` are **global** (cannot be scoped to a context); `netlify.toml` has **no env-var substitution** except signed proxy redirects.

### Functions (serverless) & Edge Functions (Deno)

**Functions** are serverless HTTP/event handlers on **AWS Lambda** (JS/TS/Go; Lambda-compatible API for legacy `event/context` handlers). They live in `netlify/functions/`, and the modern shape uses Web-standard `Request`/`Response` plus a `Config` export for routing:

```typescript
import type { Config, Context } from "@netlify/functions"

export default async (req: Request, context: Context) => {
  return new Response("Hello, world!")
}

export const config: Config = { path: "/hello" }
```

Function flavors: **web request**, **background** (async, long-running), **scheduled** (cron), and **streaming**, plus platform-event handlers (e.g. `deploySucceeded`).

**Edge Functions** run in a **Deno** runtime (built on Deno; web-standard APIs, `node:`-prefixed Node built-ins, URL-imported Deno modules, npm in beta) at the edge with sub-30ms cold starts — ideal for auth checks, personalization, and geo redirects. Signature is `(request, context)`; declared inline via `export const config` or in `netlify.toml` `[[edge_functions]]` (multiple on one path run top-to-bottom):

```typescript
import type { Config, Context } from "@netlify/edge-functions";

export default async (req: Request, { cookies, geo }: Context) => {
  if (geo.city === "Paris" && cookies.get("promo-code") === "15-for-followers") {
    return Response.redirect(new URL("/subscriber-sale", req.url));
  }
};
export const config: Config = { path: "/" };
```

`Context` exposes `next()` (chain), `geo`, `cookies`, `params`, `requestId`, `site`, `deploy`, `server.region`, and `waitUntil()`. Returning a `Response` serves directly; a `URL` rewrites; `undefined` passes through.

### Data & storage — Blobs + Netlify DB (Neon)

**Netlify Blobs** — a zero-config, highly-available **key/value + unstructured/blob** store ("optimized for frequent reads and infrequent writes"), usable as a simple KV or basic database:

```javascript
import { getStore } from "@netlify/blobs";
const uploads = getStore("file-uploads");
await uploads.set(key, file, { metadata: { country } });
await uploads.setJSON(key, { hello: "world" });
const val = await uploads.get(key, { type: "json" });
await uploads.list({ prefix: "user/" });
```

Consistency is configurable: **eventual** (default; single-region write, edge-cached globally, propagates within ~60s) or **strong** (immediate, slower reads), set per-store or per-op.

**Netlify DB** — "a fully managed Postgres database built into the Netlify platform," **powered by Neon**, with provisioning, **migrations**, and **branching** handled automatically. `netlify db init` (alias of `netlify database init`) instantly provisions an **anonymous Neon** Postgres in a region matching your functions; you get **7 days** to explore before claiming it into a Neon account. Each **Deploy Preview gets its own database branch** with a copy of production data. Query via `@netlify/neon` / `@netlify/database` (or Drizzle ORM). *Available on credit-based plans only; storage free until July 1, 2026.*

### Netlify CLI & local dev

```bash
npm install -g netlify-cli    # install
netlify login                 # browser OAuth → access token
netlify init                  # connect repo for continuous deploy
netlify link                  # link local dir to an existing site
netlify dev                   # local: serve site + functions + edge + env injection
netlify build                 # run the production build locally
netlify deploy                # deploy to a draft preview URL
netlify deploy --prod         # deploy to production
netlify env:set KEY value --context production
netlify db init               # provision Netlify DB (Neon)
netlify blobs:get / blobs:set # manage Blobs
```

`netlify dev` boots a local environment that mirrors production — runs your framework dev server, functions, edge functions, redirects, and env injection behind one local port.

### Deploy Previews & collaboration

Every PR/MR produces an isolated **Deploy Preview** at a unique URL — a full live build of that branch, with its own DB branch (Netlify DB), preview-scoped env, and a **Deploy Preview** UI for stakeholder review and **collaboration comments** layered onto the preview. **Branch deploys** publish non-production branches at stable subdomains; **split testing** can route traffic across branches. This per-PR preview polish is a signature Netlify strength.

### The Composable Web Platform (Core / Connect / Create)

- **Netlify Core** — the frontend cloud: build, deploy, edge, functions, storage.
- **Netlify Connect** — a **data-unification layer**: "bring together content from any existing or new data source, and access that data from a single **GraphQL** API." Connectors define a data model; Netlify builds a GraphQL schema, **syncs** source data, and **caches it at the edge** (cache fields drive query caching; responses over 9 KB aren't edge-cached).
- **Netlify Create** — a visual editor for content/marketing teams over the composable stack.

### AI: Agent Runners & AI Gateway

**Agent Runners** (GA Oct 2025) bring **Claude Code, OpenAI Codex, and Google Gemini** into the Netlify Dashboard to run against **live** projects — "giving secure access to your Netlify project context, deployment pipeline, build settings, and more." Agents run inside Netlify's infrastructure with access to the **codebase, logs, and deploy pipeline**, plus staging previews, rollback, and role-based log access; multiple runs go in parallel from the dashboard or a deploy-details page. Runs **consume credits** (AI inference + compute). An **AI Gateway** (beta) rounds out the AI workflow surface.

### Forms, Identity, Redirects (first-party primitives)

- **Forms** — add a `netlify` attribute to an HTML `<form>` and Netlify captures submissions automatically (no backend), with spam filtering (honeypot / reCAPTCHA) and notifications.
- **Identity** — Netlify Identity + the underlying **GoTrue** API are **officially deprecated / maintenance-only** (security fixes only; still supported as of Feb 2026 but no new features); Netlify now recommends the **Auth0 extension** as the successor.
- **Redirects / Headers / Proxy rewrites** — declarative rules (`_redirects` / `netlify.toml`) for SPA rewrites, proxies (`status = 200`), role/geo/language conditions, and custom headers.

### Pricing (credit-based)

Netlify moved to a **credit** model: everything (deploys, bandwidth, compute, requests, AI) draws from a monthly credit balance.

- **Free — $0:** 300 credits/mo; deploy from AI/Git/API; unlimited preview deploys; custom domains + SSL; functions, AI models, DB + blob storage, firewall, global CDN.
- **Personal — $9/mo:** 1,000 credits; + secret detection, 1-day observability, priority email.
- **Pro — $20/mo:** 3,000 credits; **unlimited members**; private org repos, shared env vars, 3+ concurrent builds, 30-day analytics.
- **Enterprise — custom:** unlimited credits; 99.99% SLA, enterprise edge tier, high-performance builds, **SSO & SCIM**, log drains, org management, 24/7 support.
- **Metering (illustrative):** production deploys ~15 credits (~$0.10) · bandwidth ~20 credits/GB (~$0.13) · compute ~10 credits/GB-hour · web requests ~2 credits/10k. Top-up credit packs at $5 (500) / $10 (1,500).

## Architecture

- **Control plane** — Netlify's hosted service: builds, deploys, routing configuration, add-on
  provisioning.
- **Data plane** — a global CDN with functions at origin and edge, plus attached storage and data.
- **Execution model** — build from the repository into an immutable artifact, publish atomically,
  serve from the CDN with declarative redirects and headers.
- **State authority** — Netlify's deploy history; configuration lives in `netlify.toml` in the
  repository.
- **Portability boundary** — static output is genuinely portable; functions, Blobs, Netlify DB and
  edge behaviour are the platform's.

## Where Netlify is stronger

> Shipped, evidenced capability only.

### what Netlify does well

- **Best-in-class frontend/Jamstack DX, shipping at scale** — Git→build→edge with framework auto-detection, immutable atomic deploys, instant rollback, and a build-plugin ecosystem. This is a mature, polished pipeline HoBo has only **designed**.
- **Deploy Previews polish** — per-PR live preview URLs with preview-scoped env, DB branching, and collaboration comments; a category-defining review workflow.
- **A real global edge network (100+ PoPs)** with **Edge Functions on Deno** at sub-30ms cold starts — first-party edge compute HoBo does **not** operate.
- **First-party primitives out of the box** — Blobs, Netlify DB (Neon), Forms, Identity/Redirects — "batteries included" for full-stack frontends without stitching services.
- **Composable Web Platform** — Connect (GraphQL data unification + edge cache) + Create (visual editing) target the enterprise composable-architecture buyer, marketers included.
- **Aggressive AI-native posture, shipping** — Agent Runners put Claude Code/Codex/Gemini on live projects from the dashboard **today**; Netlify DB is pitched for AI-native development.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Netlify's limits — HoBo's opening

- **Single-vendor cloud — no self-host, no BYO-cloud, no multi-cloud.** Everything runs on **Netlify's** infrastructure; you cannot deploy into your own AWS/GCP/Azure, cannot self-host, and cannot pin resources to specific providers. HoBo is **multi-cloud + IaC-agnostic** (Pulumi/Crossplane/TF/OpenTofu adapters) with typed provider-native escape hatches ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)), and **self-host = hosted** (Yard-is-a-Bindle, [Plan 4](../design/control-plane.md#plan-04)).
- **Frontend/composable-web-centric, not a backend control plane.** The compute story is FaaS (Lambda) + edge (Deno); there is **no durable/event-sourced runtime, no actors/workflows/sagas, no replay/audit**. HoBo's core is a **durable event-sourced runtime** with actors + workflows + choreography sagas ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **Language-bound compute.** Functions = JS/TS/Go on Lambda; Edge Functions = Deno (JS/TS). No polyglot-via-components. HoBo's runtime contract is **language-neutral WIT** (any wasm-compiling language, [Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **Narrow data model.** Blobs (KV/blob) + Netlify DB (Postgres via Neon) — no first-class document/graph/vector/wide-column/OLAP paradigm resource. HoBo formalizes a **paradigm taxonomy** + opt-in packages `@hobo/sql`/`vector`/`graph`/`document` ([ADR-0052/0081](../design/adr/03-data-plane.md)).
- **No platform-rules layer.** Fixed vendor mapping; no "same app, different realization per environment, auditably." HoBo adds **Resource Definitions + Matching** (`match.Decided`) + the cost-aware **Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No agents-as-principals / brokered-token identity model.** Agent Runners **run** coding agents in-dashboard, but agents are not first-class **identities** with scoped, brokered, audited capabilities. HoBo makes **agents principals** with SVIDs + MCP control surface + brokered tokens ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **No AI-generated providers / trainable functions.** The AI story is *agents editing your repo*, not a **generation pipeline** that authors + conformance-gates providers/impls, nor self-optimizing semantic functions. HoBo's generation pipeline generates adapters + UI ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)/[ADR-0056](../design/adr/03-data-plane.md#adr-0056)).
- **Identity is deprecated** (GoTrue maintenance-only → Auth0); the built-in auth primitive is a legacy path, not a strategic one.
- **Usage-metered credit billing is the business model.** Deploys, bandwidth, compute, requests, and AI all draw credits — spend scales with success. HoBo has **no billing by design** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); metering is OSS **FinOps showback**, never invoicing ([ADR-0039](../design/adr/02-identity-security.md)).

## Adversarial critique

- **The category it created got commoditized.** Static hosting with previews is now offered by every
  cloud and most PaaS products, which is why the product has expanded into functions, storage and
  data — into a market with much stronger incumbents.
- **Backend features are catch-up features.** Blobs and Netlify DB are credible and are not
  positioned against a hyperscaler's durability, scale or compliance guarantees.
- **Edge function constraints** — runtime, size and execution limits — shape what can be built, and
  the boundary between edge and origin execution is a real design burden pushed to the user.
- **Build minutes and bandwidth pricing** are the historical friction point, and they scale with
  exactly the preview-per-PR behaviour the product encourages.
- **Framework-neutral is a weaker position than framework-owning**, commercially: Netlify does not
  own a framework the way its nearest competitor does.
- **No self-host, no BYOC.**

### Comparisons with adjacent tools

- **vs HoBo:** Netlify is **frontend/composable-web on its own single-vendor cloud, shipping, polished**; HoBo is a **backend/infra control plane — multi-cloud, wasm-default, event-sourced, self-hostable, AI-native**, still in design. Overlap is a thin band (frontend hosting, functions, edge, blobs, sql, agent moves); the divergence is the whole platform shape. On the overlap, **Netlify is ahead today** (build pipeline, Deploy Previews, edge at scale); on the surrounding system, HoBo's design is broader.
- **vs Vercel:** the closest rival — both are frontend clouds with Git→edge pipelines. Netlify differentiates on first-party primitives (Blobs/DB/Forms/Identity), Connect's data unification, and Deno-based Edge Functions; Vercel leans Next.js-native + its own edge.
- **vs Encore / Nitric:** those are **infrastructure-from-code into your AWS/GCP/Azure**; Netlify is the opposite — **its own cloud, no BYO**. HoBo sits with Encore/Nitric on multi-cloud/BYO and IfC authoring, against Netlify's single-vendor model.
- **vs Convex / Supabase:** managed backends with their own primitives; Netlify is frontend-first with backend primitives bolted alongside. All three are single-vendor clouds where HoBo is multi-cloud + self-host.
- **vs Cloudflare:** both run edge networks with edge compute + KV/blob + DB; Cloudflare is infra/edge-primitive-centric, Netlify is frontend-DX-centric. Neither is multi-cloud or self-hostable the way HoBo is.

**Net:** Netlify is the **shipping frontend/composable-web leader** and a genuine reminder that on the overlap — build pipeline, Deploy Previews, edge functions at scale, Jamstack DX — it is **ahead of design-phase HoBo today**. But Netlify is **frontend/composable-web-centric, single-vendor cloud, language-bound, usage-billed**; HoBo is **backend/infra-control-plane, multi-cloud + pluggable-IaC, wasm-polyglot, event-sourced + governed, self-hostable, and billing-free by design**. The competitive line is not "who builds frontends better" (Netlify wins) but "who controls infrastructure across clouds with a durable runtime and AI-native governance" (HoBo's bet).

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Netlify concept. ✅ designed at parity (anchored) · ➕ HoBo goes further · ◐ partial / thin (HoBo is design-phase; Netlify ships) · 🔜 planned · ✗ deliberately out of scope.

| Netlify concept | HoBo equivalent | Status | Notes |
|---|---|---|---|
| **Git-push → build → deploy** pipeline | control-plane deploy + **Harness** progressive delivery ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ◐ | Netlify's polished Git build pipeline + framework detection **ships**; HoBo's deploy/rollout is designed, not built |
| `netlify.toml` file config | `hobo.config.ts` + **manifest IR** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | declarative config → IR designed |
| **Functions** (serverless, Lambda; JS/TS/Go) | `hobo:service`/`api` port ([ADR-0114](../design/adr/02-identity-security.md#adr-0114)) on the wasm runtime ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ | polyglot **wasm** vs Lambda's fixed langs; but Netlify's FaaS ships at scale |
| **Edge Functions** (Deno, 100+ PoP edge) | wasm components + `component-host` ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ◐ | different substrate; **HoBo runs no first-party edge network** — depends on provider CDNs/edge |
| **Netlify Blobs** (KV + blob store) | `wasi:blobstore` bucket + `wasi:keyvalue` kv ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | KV + object ports designed; consistency modes map to port config |
| **Netlify DB** (Neon Postgres, branching) | `hobo:sql` port + migrations ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) + Neon adapter | ✅ | sql port + declarative migrations designed; Neon is a valid adapter target |
| Frontend hosting — static + SSR + CDN | `web()` resource (static/SSR + CDN) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ | `web()` designed; **no Jamstack build ecosystem / framework-adapter breadth** at Netlify's level |
| **Deploy Previews** (per-PR URL + collaboration) | ephemeral/preview **Camps** + Harness ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ◐ | preview envs designed; **no per-PR preview-URL polish / collaboration-comment UI** yet |
| **Netlify Connect** (GraphQL data unification) | data-plane **projections / materialized views + reactor** ([Plan 11](../design/data-plane.md#plan-11)) | ◐ | HoBo has projections/reactive reads, **not a GraphQL data-federation product** |
| Edge / durable **cache** | the new app-facing `cache` port (ADR-0118, in progress) | 🔜 | port being added this tranche; not yet a full design |
| **Netlify Identity** (deprecated → Auth0) | `hobo:auth` federate + verify ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)) | ✅ | auth port designed; note Netlify's own primitive is **maintenance-only** |
| **Forms** (HTML-attribute capture) | `notify` port ([ADR-0059](../design/adr/03-data-plane.md#adr-0059)); *no forms primitive* | 🔜 | no first-class forms capture; closest is notify + a service handler |
| **Redirects / Headers / rewrites** | `hobo:http` routing + `web()` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ | route/rewrite modeling designed; not a `_redirects`-grade rules DSL |
| `netlify` CLI (`dev`/`deploy`/`db`) | `hobo dev`/`up`/`down` ([Plan 7](../design/developer-experience.md#plan-07)) | ◐ | CLI designed, not shipping |
| **Agent Runners** (Claude/Codex/Gemini in-dashboard) | **agents-as-principals** + MCP + brokered tokens ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ / ◐ | HoBo's identity/authz model is **deeper**; Netlify **ships** the in-dashboard runner product, HoBo is design |
| **AI Gateway** (beta) | AI generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)); *no gateway product* | 🔜 | no shipping gateway equivalent |
| Vector / semantic search | `vector` + `search` ports ([ADR-0034](../design/adr/03-data-plane.md#adr-0034)) | ➕ | Netlify has no first-class vector/search; HoBo does |
| Single-vendor cloud (own infra) | multi-cloud provider adapters + pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)) | ➕ | multi-cloud + IaC-agnostic vs Netlify-only |
| SaaS-only (no self-host) | **Yard-is-a-Bindle** — self-host = hosted ([Plan 4](../design/control-plane.md#plan-04)) | ➕ | OSS self-host parity vs no self-host |
| **Credit-based usage billing** | **✗ by design** — no billing ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); metering = OSS FinOps showback ([ADR-0039](../design/adr/02-identity-security.md)) | ✗ | HoBo deliberately does **not** meter-to-invoice |
| *(none)* | **Event-sourced control plane + audit/replay** ([Plan 11](../design/data-plane.md#plan-11)) | ➕ | |
| *(none)* | **Multi-tenant-app primitives** ([Plan 50](../design/security-networking.md#plan-50)) | ➕ | |
| *(none)* | **Contracts / `can-deploy` + policy planes** ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ➕ | |
| *(none)* | **`hobo import`** adopt-in-place migration ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ | |

### The one-line takeaway

**Netlify proves the frontend/composable-web pipeline in production — and on the overlap (build, Deploy Previews, edge functions, Jamstack DX) it is ahead of design-phase HoBo today.** But Netlify is bounded to **its own single-vendor cloud, language-bound compute, a narrow data model, and a usage-metered credit business**. HoBo's differentiation is orthogonal: **backend/infra control plane across many clouds + pluggable IaC, a language-neutral wasm runtime, a durable event-sourced runtime with actors/workflows/sagas, a broad data-paradigm catalog, agents-as-principals + a generation pipeline, self-host = hosted, and no billing by design.** The two barely compete on frontends; they compete on **who owns the infrastructure control plane**.

## Better-together / integration posture

- **Benchmark** — atomic deploys with instant rollback remain a clean model worth matching.
- **Borrow** — **declarative redirects and headers committed with the site** is a good, small pattern
  for HoBo's gateway port: routing as part of the application description rather than platform
  configuration.
- **Provider-target** — reasonable for static and edge-shaped Bindle outputs.
- Not a displace or adopt target.

## Threats and lessons

1. **A category can be won and still not be defensible.** Netlify created the Jamstack deployment
   experience and now competes with everyone who copied it. The lesson for HoBo is that an experience
   is not a moat; the description that outlives the vendor might be.
2. **Expanding into adjacent primitives is the default survival move**, and it puts a smaller vendor
   against much larger ones on their own ground.
3. **Atomic deploy and instant rollback are minimum expectations** for any delivery story.

## Sources

- [docs.netlify.com](https://docs.netlify.com/) — sites, deploys, previews, Functions, Edge Functions, Blobs, Netlify DB, redirects and headers
- [netlify.com](https://www.netlify.com/) — positioning (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current pricing, limits and the Netlify DB offering were not re-verified
in this pass and are not asserted.
