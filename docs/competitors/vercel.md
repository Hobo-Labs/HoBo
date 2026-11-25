---
type: Competitive Reference
title: "Vercel — competitor reference"
description: "Vercel is the category-defining **Frontend Cloud** (creators of Next.js) — Git-push deploys, a global Edge Network, Fluid compute + Active CPU pricing, the open-source **Workflow SDK** (durable `use workflow`/`use step`), Vercel Storage + Marketplace, and shipping AI-app tooling (AI SDK, AI Gateway, v0, Vercel Agent). HoBo borrows its durable-workflow ergonomics + runtime ports."
tags: [hobo, competitors]
competitor:
  slug: vercel
  name: "Vercel"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, agentic-infrastructure]
  directness: overlapping
  role: "frontend cloud plus durable Workflow SDK and AI stack — borrow-source promoted to full parity capture"
  posture: [benchmark, borrow, provider-target]
  hobo_surface: [delivery, environments, agent-surface]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://vercel.com/docs
    - https://vercel.com/
---

# Vercel — competitor reference

> A faithful capture of **Vercel** for HoBo competitive analysis, and the one competitor HoBo openly **borrows from**. Vercel is a **shipping, category-defining Frontend Cloud** — the creators of **Next.js** — with world-class DX, a real global edge network, and production AI-app tooling (**v0**, the **AI SDK**, **AI Gateway**, **Vercel Agent**). It is *not* HoBo-shaped: Vercel is **frontend-centric and its own single-vendor platform**; HoBo is a **backend/infra control plane** that is multi-cloud, wasm-default, and self-hostable. Where the two touch is **durable execution**: HoBo borrows the **Workflow SDK's** durable `workflow`/`step` feel and its **runtime ports/adapters** ([`vision.md:70`](../design/vision.md#what-hobo-borrows-deliberately)). **HoBo is design-phase; Vercel ships all of the below today** — be explicit about that gap throughout. Sources: [vercel.com](https://vercel.com/) · [vercel.com/docs](https://vercel.com/docs) · [vercel.com/docs/workflows](https://vercel.com/docs/workflows) · [workflow-sdk.dev](https://workflow-sdk.dev/) · [github.com/vercel/workflow](https://github.com/vercel/workflow) · [ai-sdk.dev](https://ai-sdk.dev/) · [vercel.com/docs/fluid-compute](https://vercel.com/docs/fluid-compute) · [vercel.com/pricing](https://vercel.com/pricing). License: the **platform is proprietary SaaS**; the **Workflow SDK** (`workflow`, **Apache-2.0**) and the **AI SDK** (`ai`, open source) are OSS. Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Vercel is the **Frontend Cloud**: a fully managed platform for building and deploying web applications and, increasingly, AI applications and agents. You connect a Git repo, and every push produces a build and a deployment on Vercel's **Edge Network** — a global CDN plus a compute layer (**Vercel Functions**). Vercel authors and stewards **Next.js**, and its DX gravity (zero-config framework detection, **Preview Deployments** per push, **ISR**, Image Optimization) is the reference bar the industry measures against. The mental model is **frontend-out**: the framework and the edge are first-class; backend concerns (functions, storage, queues, workflows) hang off that.

Over 2024–2026 Vercel expanded well past static/SSR hosting into (a) **Fluid compute** — a serverless/server hybrid with in-function concurrency and **Active CPU pricing**; (b) **durable execution** — the open-source **Workflow SDK** and managed **Vercel Workflows**, the piece HoBo explicitly borrows; and (c) a deep **AI stack** — the **AI SDK** (the most-adopted TypeScript AI toolkit), **AI Gateway** (one endpoint to hundreds of models), **v0** (text-to-app), and **Vercel Agent** (an in-dashboard agent that reviews PRs and investigates incidents). Storage was refactored: first-party **Vercel Postgres** was sunset and migrated to **Neon**, leaving **Blob** and **Edge Config** as the only first-party stores and pushing databases into the **Vercel Marketplace** (Neon, Upstash, Supabase, …) with native provisioning + billing.

Vercel is **vendor-hosted** — you deploy *to Vercel*, not into your own cloud. The one portable surface is the **Workflow SDK**, whose **"Worlds"** abstraction lets the durable runtime run on Vercel, locally, on a self-hosted Postgres, or on community adapters (Redis, MongoDB, Turso, Cloudflare, …). Monetization is **usage-based** (Active CPU, bandwidth, Workflow events, build minutes) layered on Hobby/Pro/Enterprise seats — a model HoBo deliberately does **not** adopt ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

| Dimension | Vercel |
|---|---|
| Category | **Frontend Cloud** — managed platform to build + deploy web & AI apps; **creators of Next.js** |
| Authoring | Framework-native (Next.js, SvelteKit, Nuxt, Astro, Remix, …), Git-push-to-deploy; `vercel.json` (or programmatic `vercel.ts`) |
| Compute | **Vercel Functions** on **Fluid compute** — in-function concurrency, `waitUntil` background work, bytecode caching, AZ/region failover; runtimes **Node.js · Python · Edge · Bun · Rust**; 300s default / **800s** max / 1800s (beta) |
| Durable execution | **Vercel Workflows** + open-source **Workflow SDK** (`workflow`, Apache-2.0): `"use workflow"` / `"use step"`, `sleep`, hooks, deterministic replay; **Worlds** portability adapters; **DurableAgent** |
| Frontend/edge | Global **Edge Network** CDN · **ISR** (stale-while-revalidate) · Image Optimization · Routing Middleware · **Preview Deployments** per push |
| Storage | First-party **Blob** + **Edge Config**; **Marketplace** for Postgres/KV/NoSQL (**Neon, Upstash, Supabase**, …); Vercel Postgres → Neon |
| AI | **AI SDK** (`ai`, OSS) · **AI Gateway** (unified model API + spend budgets + BYOK) · **v0** (text-to-app + Platform API) · **Vercel Agent** (PR review + investigations) |
| Security | **Vercel Firewall + WAF** (managed rulesets + custom rules) · **BotID** (invisible CAPTCHA) · DDoS · Secure Compute · OIDC/RBAC/SSO/Audit Logs |
| Self-host | Platform is **vendor-hosted only**; only the **Workflow SDK** runtime is portable (Local / self-host Postgres **Worlds**) |
| Clouds | Vercel's **own** platform + edge; **not** multi-cloud / BYO-cloud provisioning |
| License / price | Platform **proprietary**; SDKs **OSS**. **Hobby** free (non-commercial) · **Pro $20/user/mo** (+usage) · **Enterprise** custom; **usage-billed** (Active CPU **$0.128/hr**, provisioned memory **$0.0106/GB-hr**, bandwidth, Workflow events) |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Project** | A repository plus its deployment configuration (`vercel.json`) |
| **Deployment** | An immutable build, addressable by URL — every push produces one |
| **Preview deployment** | The per-branch/per-PR URL that made preview environments an industry expectation |
| **Function** | Serverless compute, with **Fluid compute** and Active CPU billing changing the economics of idle time |
| **Edge Network** | Global routing, caching and ISR |
| **Workflow SDK** | Durable execution: `workflow` and `step` primitives — the part HoBo explicitly borrows |
| **AI stack** | AI SDK, AI Gateway, v0, and agent tooling |

The mental model is **every push is a URL**. Immutable deployments plus preview URLs turned review
into something you click rather than something you provision, and that single idea propagated across
the entire cohort.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | Immutable deployments and preview URLs, the reference implementation |
| `environments` | Preview per branch, promotion by alias |
| `agent-surface` | A shipped AI stack — SDK, gateway, generation, agents |
| `authoring` | Zero-config for supported frameworks; `vercel.json` when needed |
| `replay-migration` | **The Workflow SDK's durable `workflow`/`step` model is HoBo's acknowledged borrow-source** for authoring feel |

Vercel is simultaneously a borrow-source, a benchmark, and a plausible provider target — which is
why the posture here is deliberately not "displace".

## Feature surface

### Frontend Cloud, Next.js, Edge Network, ISR & Preview Deployments

- **Git-push to deploy.** Connect a repo; each commit builds and deploys. Framework preset auto-detected (or set via `vercel.json`).
- **Preview Deployments** — every push gets a **unique, isolated preview URL** with the full production toolchain, plus the **Vercel Toolbar** for comments/collaboration and **Draft Mode** to bypass caching. This is the gold-standard per-PR review-app loop.
- **Edge Network** — a global CDN + compute edge; static assets replicate to every region; **Routing Middleware** runs logic before the cache.
- **ISR (Incremental Static Regeneration)** — `stale-while-revalidate` caching: cached responses served instantly from the CDN in every region, backed by durable single-region persistence (retained 31 days). Supports **time-based** and **on-demand** revalidation; **request collapsing** (one function invocation per region under a stampede); revalidations propagate to all regions within ~300ms.
- **Image Optimization** — on-demand at runtime, configured via `vercel.json` `images` (sizes, formats, remote patterns, quality allow-lists).

### Compute — Vercel Functions + Fluid compute + Active CPU

**Fluid compute** (default for new projects since Apr 2025) is a serverless/server hybrid:

- **Optimized concurrency** — multiple invocations share one instance (I/O-bound AI/embedding/DB workloads reuse idle capacity instead of spinning fresh microVMs).
- **`waitUntil`** — run background work (logging, analytics) after the response is sent.
- **Bytecode caching** (Node 20+) + function pre-warming → reduced cold starts; **AZ + cross-region failover**; **error isolation** (one broken request doesn't crash co-tenants on the instance).
- Runtimes: **Node.js, Python, Edge, Bun, Rust**. Durations: **300s** default, **800s** max (Pro/Ent), **1800s** extended (beta). For unbounded runtime, Vercel points you at **Workflows**.
- **Active CPU pricing** — bills CPU **only while code actively executes** (**$0.128 / Active CPU-hr**) + **provisioned memory** (**$0.0106 / GB-hr**) + invocations; up to ~90% cheaper for idle-heavy workloads (LLM inference, long agents). Enabled via `"fluid": true` in `vercel.json`.

### Durable execution — the Workflow SDK (what HoBo borrows)

The open-source **Workflow SDK** (`workflow`, Apache-2.0) turns ordinary async TypeScript (also Python via the `vercel` SDK) into **durable, resumable** execution using **two directives** and four concepts — **workflow, step, sleep, hook**:

```typescript
// A workflow: durable, resumes exactly where it left off across crashes/deploys
export async function aiContentWorkflow(topic: string) {
  'use workflow';
  const draft = await generateDraft(topic);
  const summary = await summarizeDraft(draft);
  return { draft, summary };
}

// A step: stateless unit of durable work, auto-retried, survives process crashes
async function generateDraft(topic: string) {
  'use step';
  return await aiGenerate({ prompt: `Write a blog post about ${topic}` });
}
```

- **Determinism/replay.** A workflow compiles into a route that orchestrates execution; **all inputs/outputs are recorded in an event log**, and on crash/deploy the system **replays deterministically** from where it stopped. Each step compiles into an isolated route; while a step runs, the workflow **suspends without consuming resources**.
- **`sleep`** — `await sleep('7 days')` pauses for minutes-to-months **consuming no compute**, resuming automatically.
- **Hooks** — `defineHook()` + `hook.create({ token })` / `hook.resume(token, data)` pause a workflow until an external event (human approval, webhook, third-party callback) arrives — human-in-the-loop with no polling or bespoke queues.
- **Skew Protection** — runs keep executing on the deployment they started on, so new deploys don't disturb in-flight runs.
- **DurableAgent** — makes AI agents durable/resumable: **each tool execution becomes a retryable, observable step** (mirrored by AI SDK 7's `@ai-sdk/workflow` + `WorkflowAgent`).
- **"Worlds" (portability)** — the adapter system that makes workflows portable. Each **World** supplies the three things a workflow needs — an **event log, compute, and a queue** — and they are **modular and swappable**: **Managed** (Vercel Fluid + Vercel Queues + managed persistence + E2E encryption), **Local** (dev, built in), **Self-hosted** (a Postgres reference impl run in production), and **community** Worlds (Redis, MongoDB, Turso, Jazz, Cloudflare). This "event-log + compute + queue behind swappable adapters" shape is exactly the **runtime ports** idea HoBo borrows.
- **Managed Vercel Workflows** — Vercel runs the SDK for you: **Functions** execute workflow/step code, **Vercel Queues** drive them reliably, **managed persistence** stores state + event logs, and the dashboard gives built-in **observability** (every step/input/output/sleep/error traced). Pricing is **usage-based**: Events, Data Written, Data Retained.

### `vercel.json` — project configuration

Declarative config (add `"$schema": "https://openapi.vercel.sh/vercel.json"` for validation); a programmatic `vercel.ts` variant also exists. Top-level keys include `buildCommand`, `devCommand`, `installCommand`, `outputDirectory`, `framework`, `functions`, `regions`, `functionFailoverRegions`, `rewrites`, `redirects`, `bulkRedirectsPath`, `headers`, `routes`, `crons`, `cleanUrls`, `trailingSlash`, `images`, `fluid`, `bunVersion`, `ignoreCommand`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "fluid": true,
  "regions": ["iad1"],
  "functions": {
    "api/eu-data.js": { "maxDuration": 30, "regions": ["cdg1"], "functionFailoverRegions": ["lhr1"] }
  },
  "crons": [{ "path": "/api/every-hour", "schedule": "0 * * * *" }],
  "rewrites": [{ "source": "/proxy/:m*", "destination": "https://example.com/:m*" }],
  "redirects": [{ "source": "/me", "destination": "/profile.html", "permanent": true }],
  "headers": [{ "source": "/(.*)", "headers": [{ "key": "X-Frame-Options", "value": "DENY" }] }]
}
```

- **`functions`** (glob → per-function): `runtime`, `maxDuration`, `supportsCancellation`, `includeFiles`/`excludeFiles`, per-function `regions`/`functionFailoverRegions` (memory is set in the dashboard when Fluid is on).
- **`crons`** — 5-field UTC schedule strings hitting a `path`.
- **`routes`** (low-level PCRE) — adds edge **`transforms`** (append/set/delete request/response headers, query, `request.path`), `mitigate` (WAF `challenge`/`deny`), and env-var expansion; higher-level `rewrites`/`redirects`/`headers` are preferred. Newer `services` blocks (root/entrypoint/routes) point Vercel at containerized backends.

### `vercel` CLI

```bash
vercel dev                 # run the platform (functions, routing) locally
vercel                     # deploy a Preview
vercel deploy --prod       # deploy to Production
vercel promote <url>       # promote a prior deployment to production
vercel rollback [url]      # roll production back to a previous deployment
vercel pull                # cache env vars + project settings locally
vercel env pull            # write env vars to .env.local
vercel link                # connect a local dir to a Vercel project
vercel build               # build locally with Vercel's pipeline
vercel logs | certs | dns | redeploy   # ops surfaces
```

### Vercel Storage + Marketplace

- **First-party:** **Blob** (`@vercel/blob`, S3-style object storage) and **Edge Config** (`@vercel/edge-config`, ultra-low-latency key **reads** at the edge for flags/config).
- **Databases via Marketplace:** first-party **Vercel Postgres** was **sunset and migrated to Neon**; **Vercel KV** was **Upstash Redis**. Databases are now **Marketplace native integrations** — **Neon** (Postgres), **Upstash** (Redis/KV/Vector/Queue), **Supabase**, and more. Native integrations give **one-click provisioning, auto-injected connection strings/credentials as env vars, unified billing**, and (for supported Postgres) a dashboard SQL/schema browser.

### AI stack — AI SDK · AI Gateway · v0 · Vercel Agent

- **Vercel AI SDK** (`ai`, open source; ~11.5M weekly downloads) — the most-adopted TS AI toolkit. **Core** (`generateText`, `streamText`, `generateObject`) runs server-side over a **provider-agnostic** interface (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …); **UI** (`useChat`, `useCompletion`, `useObject`) manages streaming state in React/Svelte/Vue. **Agents** = a `generateText`/`streamText` call with tools + `maxSteps > 1` (reason→call tool→observe→repeat). AI SDK 7 adds `@ai-sdk/workflow` + `WorkflowAgent` for durable agents.
- **AI Gateway** — one endpoint to **hundreds of models**; switch models via a `creator/model` string with no app rewrite; **spend budgets**, usage/TTFT/token **observability** (team/key/project scope), automatic **retries + load-balancing + managed fallback**, and **BYOK** — **no markup on tokens**. The AI SDK auto-routes through it.
- **v0** ([v0.app](https://v0.app/)) — text-to-app: prompt → project → code files → deployment, with a VS Code-style editor, Git integration, DB connectivity, and agentic workflows. The **v0 Platform API** (beta, REST) exposes that full generate→deploy lifecycle so others can build app-builders on top.
- **Vercel Agent** (beta; Pro/Enterprise) — lives in the dashboard and reads platform signals (deployments, logs, metrics, config, usage, connected repos): **Code Review** analyzes PRs with multi-step reasoning for security/logic/perf issues and **generates patches validated in secure sandboxes** against your real builds/tests/linters; **Investigations** auto-start on alerts to surface root cause.

### Security & networking

**Vercel Firewall** with a **WAF** (custom rules + managed **Bot Protection** / **AI Bots** rulesets; actions `challenge`/`deny`), **BotID** (an **invisible, ML-based CAPTCHA**), managed DDoS mitigation and rate limiting, **Secure Compute** (private networking), **OIDC**, **RBAC/SSO**, **Audit Logs**, and 2FA. Custom **domains**/DNS + managed TLS.

### Pricing

- **Hobby** — free, **non-commercial only**.
- **Pro** — **$20/user/mo** with $20 usage credits, then **usage-based** (bandwidth, Active CPU, build minutes, ISR, Workflows events, …).
- **Enterprise** — custom (SSO/SCIM, Secure Compute, higher limits, SLAs, support).
- **Usage rates** — Fluid **Active CPU $0.128/hr** + provisioned memory **$0.0106/GB-hr**; **AI Gateway** no token markup (BYOK); **Workflows** billed on Events / Data Written / Data Retained. Monetization + the Marketplace revenue model are core to Vercel — and explicitly **out of scope** for HoBo ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Architecture

- **Control plane** — Vercel's hosted service: builds, deployments, aliases, routing configuration.
- **Data plane** — a global edge network plus serverless function execution; Fluid compute keeps warm
  capacity and bills Active CPU, which materially changes serverless cost behaviour.
- **Execution model** — build once per push into an immutable deployment, alias to promote, route at
  the edge with ISR for incremental regeneration.
- **Durable execution** — the Workflow SDK provides `workflow`/`step` semantics over the same
  serverless substrate, which is the interesting architectural move: durability as a library over
  ephemeral compute.
- **State authority** — Vercel's deployment history, which is immutable and alias-addressed.
- **Portability boundary** — framework-shaped. Next.js applications are portable in principle and
  practically advantaged on Vercel; the edge behaviour, ISR semantics and workflow runtime are the
  platform's.

## Where Vercel is stronger

> Shipped, evidenced capability only.

### what Vercel does well — and is ahead of HoBo on

- **Best-in-class frontend DX and a real edge network.** Git-push deploys, per-push **Preview Deployments**, **ISR**, Image Optimization, and Routing Middleware on a **global CDN** — shipping at massive scale. HoBo is **not a frontend cloud** and does not compete here.
- **Next.js gravity + ecosystem.** Vercel authors Next.js; the framework's popularity is a durable distribution moat no design-phase competitor can match.
- **Shipping AI-app tooling.** **v0** (production text-to-app), the **AI SDK** (the most-used TS AI library), **AI Gateway** (unified models + budgets), and **Vercel Agent** (PR review + investigations) are **live products**, not roadmaps.
- **Fluid compute + Active CPU pricing** — a genuinely differentiated compute + billing model (pay for active CPU, not wall-clock), well-suited to AI/agent idle time.
- **Durable execution done ergonomically** — the **Workflow SDK's** `"use workflow"`/`"use step"` directives + `sleep` + hooks are a clean, familiar-async programming model with deterministic replay, an event log, and swappable **Worlds**. **This is the design HoBo borrows from.**
- **Cohesive, opinionated, single-vendor platform** — one dashboard, one bill, one deploy target; low decision-cost for frontend teams.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Vercel's limits — HoBo's opening

- **Single-vendor platform, not multi-cloud.** You deploy *to Vercel* (built on AWS + others), not into **your own** AWS/GCP/Azure/Hetzner/Cloudflare/Fly account, and you cannot bring Pulumi/Crossplane/Terraform/OpenTofu. HoBo is a **cloud-agnostic control plane with pluggable IaC** ([Plan 4](../design/control-plane.md#plan-04), [ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **Frontend-out, not a backend/infra control plane.** Vercel optimizes the framework + edge; backend infra (databases, queues, secrets, provisioning, IAM) is comparatively thin, and databases were **offloaded to the Marketplace**. HoBo is **backend-first**: a full IfC resource catalog + `.allow()` least-privilege + Resource Definitions/Matching + a Dispatcher ([Plan 21](../design/authoring-resources-wiring.md#plan-21), [Plan 25](../design/platform-engineering.md#plan-25)).
- **JavaScript/TypeScript (+ Python) bound.** No polyglot component runtime. HoBo's contract is **language-neutral WIT** over a **wasm-default** runtime ([Plan 20](../design/wasm-runtime-wit.md#plan-20), [ADR-0031](../design/adr/01-architecture-core.md#adr-0031), [ADR-0072](../design/adr/01-architecture-core.md#adr-0072)).
- **Platform self-host is off the table.** Only the **Workflow SDK** is portable (via Worlds); the platform, edge, Functions, and AI stack are vendor-only — there is no "run Vercel yourself." HoBo's **Yard is a Bindle** — self-host = hosted parity, OSS ([Plan 4](../design/control-plane.md#plan-04), [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).
- **Durability without an event-sourced *control plane*.** Workflows give per-run deterministic replay, but Vercel has no **event-sourced control plane** over the whole platform (audit/replay/time-travel of *infrastructure* decisions), no `can-deploy`/contracts/policy planes, and no cost plane beyond usage billing. HoBo makes the **entire runtime + control plane event-sourced** ([Plan 11](../design/data-plane.md#plan-11), [ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) and adds contracts/policy/flags ([Plan 29](../design/contracts-policy-flags.md#plan-29)).
- **Usage billing + Marketplace revenue are the business model.** Great for Vercel, but they mean cost scales with success and lock-in concentrates in the platform. HoBo has **no billing/monetization/marketplace-revenue by design**; metering is **OSS FinOps showback** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039), [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).
- **Agents are assistants on Vercel's platform, not first-class principals.** Vercel Agent and DurableAgent are powerful, but there is no **agent-as-identity** model (SVIDs, brokered tokens, capability manifests) governing *what an agent may do across clouds*. HoBo makes **agents first-class principals** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **No AI-generated providers / adopt-in-place onboarding.** v0 generates *apps*; it does not generate **cloud provider adapters/implementations**, and there is no "import my existing TF/Pulumi estate." HoBo's generation pipeline generates adapters ([Plan 23](../design/generated-stack.md#plan-23)) and `hobo import` adopts estates in place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).

## Adversarial critique

- **Framework gravity is the business model.** Vercel maintains the framework and the platform most
  optimized for it; that is legitimate and it means "portable" and "equally good elsewhere" are
  different claims.
- **Serverless pricing is famously hard to predict.** Fluid compute and Active CPU billing improve
  the economics and add another dimension to model; traffic spikes remain the recurring cost story.
- **The edge is a constraint as well as a feature.** Cold starts, execution limits and regional data
  access shape what can be built, and applications that outgrow the model must restructure.
- **Backend workloads are second-class.** Long-running processes, stateful services and heavy
  background work fit awkwardly; the Workflow SDK addresses part of this by adding durability rather
  than by adding a runtime.
- **AI stack claims move quickly.** The surface is broad and evolving; treat capability claims as
  claims to verify rather than as settled ground.
- **No self-host and no BYOC.** The whole model presumes Vercel operates it.
- **Vendor-shaped configuration.** `vercel.json` describes Vercel routing and build behaviour, not an
  application.

### Comparisons with adjacent tools

- **vs HoBo:** Vercel is a **shipping, frontend-centric, single-vendor cloud** with unmatched web/edge DX and live AI tooling; HoBo is a **design-phase, backend/infra control plane** that is **multi-cloud + wasm-polyglot + self-hostable + event-sourced/governed**. They overlap only at **durable execution**, where HoBo deliberately **borrows** Vercel's model (below). Vercel is ahead on everything frontend, edge, ecosystem, and AI-app DX **today**; HoBo's bet is breadth (clouds/languages/IaC) + a governed control plane, not out-DX-ing Vercel on the frontend.
- **vs Encore/Nitric:** those are **cloud-agnostic IfC → your own AWS/GCP(/Azure)**; Vercel is the opposite trade — **its own managed platform** with superior frontend DX but no BYO-cloud. HoBo is closer to Encore/Nitric on *where it runs* and closer to Vercel on *durable-runtime ergonomics + AI-native posture*.
- **vs Convex/Lakebed:** all three are single-runtime/AI-forward; Vercel is the biggest and most frontend-complete. HoBo's edge over the whole set is agnostic ports + event-sourced runtime + agents/generation pipeline.
- **vs Cloudflare (Workers/Durable Objects/Workflows):** the closest "own-platform edge + durable execution" peer; both ship durable primitives. HoBo abstracts *over* such platforms as providers behind WIT ports rather than being one.

**Net:** Vercel is a category-defining Frontend Cloud that is **shipping and ahead** on frontend/edge DX, Next.js gravity, and AI-app tooling — and it is the product HoBo **learns from** rather than races on that turf. HoBo's differentiation is orthogonal: a **multi-cloud, wasm-default, self-hostable, event-sourced control plane** with agents-as-principals and a generation pipeline. From Vercel, HoBo takes exactly one thing on purpose — the **durable `workflow`/`step` ergonomics and the "Worlds" runtime-ports pattern** — and generalizes it beyond a single vendor's platform.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Vercel concept. **HoBo is design-phase throughout**, so these markers describe **design coverage**, not shipping status (Vercel ships all of it): ✅ designed at parity · ➕ designed to go further · ◐ partial/thin · 🔜 planned. Never read ✅ as "HoBo ships this."

| Vercel concept | HoBo equivalent | Status |
|---|---|---|
| **Workflow SDK** — durable `"use workflow"` / `"use step"`, `sleep`, hooks, deterministic replay | actors + **durable workflows + choreography sagas** over an **event-sourced** store ([Plan 11](../design/data-plane.md#plan-11), [ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ designed to exceed (event-sourced replay/time-travel/audit as the control-plane substrate) — **but Vercel ships this; HoBo does not** |
| **Worlds** — swappable event-log + compute + queue adapters (portable runtime) | **WIT ports + provider adapters + wRPC membrane** ([Plan 20](../design/wasm-runtime-wit.md#plan-20), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) — the **runtime ports HoBo borrows** | ✅/➕ generalized to *all* resources, not just the workflow substrate — design-phase |
| **DurableAgent** — agent = durable resumable workflow, each tool call a step | agents-as-principals + durable workflows + trainable `"use training"` fns ([Plan 6](../design/ai-native-agent-auth.md#plan-06), [Plan 11](../design/data-plane.md#plan-11)) | ◐ conceptual; no shipping durable-agent runtime |
| **Vercel Functions + Fluid compute** (in-fn concurrency, Node/Python/Edge/Bun/Rust) | `service`/`api` on the **wasm-default** runtime ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 21](../design/authoring-resources-wiring.md#plan-21)) + Dispatcher cost routing ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ◐ different substrate; **no edge network, no Active-CPU compute platform** |
| **Frontend Cloud** (Next.js hosting, SSR, Edge CDN, Image Optimization) | `web()` resource (static/SSR + CDN) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ HoBo is **not a frontend cloud** — maps the primitive only; no edge network / Next.js gravity |
| **ISR** (stale-while-revalidate, on-demand + time revalidation, request collapsing) | `web()` + app-facing **`cache` port** + materialized/reactive reads ([Plan 11](../design/data-plane.md#plan-11)) | 🔜/◐ ISR-grade caching not designed in depth |
| **Preview Deployments** (per-push URLs, Toolbar, Draft Mode) | **ephemeral/preview Camps** + **Harness** progressive delivery = OpenFeature/OpenDelivery/OpenExperiment ([Plan 25](../design/platform-engineering.md#plan-25), [ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ✅/➕ maps preview + flags + experiments — design-phase |
| **`vercel.json`** (declarative build/routing/functions/crons config) | `hobo.config.ts` + **manifest IR** + Camps ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ declarative config → collected IR (Vercel's is frontend-routing-centric) |
| **`vercel` CLI** (dev/deploy/env/promote/rollback) | `hobo` CLI (dev/up/down/collect/plan) ([Plan 7](../design/developer-experience.md#plan-07)) + dashboard/status ([Plan 49](../design/developer-experience.md#plan-49)) | ✅ near-parity in design |
| **Vercel Storage — Blob** | `bucket` → `wasi:blobstore` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ |
| **Vercel Storage — KV** (Upstash Redis) | durable `kv` → `wasi:keyvalue` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); Redis-as-cache → the new ephemeral **`cache`** port ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)) | ✅ kv · 🔜 cache |
| **Edge Config** (low-latency edge reads for flags/config) | app-facing **`cache` port** ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)) + flags via `flag()` ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ◐ designed |
| **Postgres** (via Neon) | `sql` port (+ migrations [ADR-0032](../design/adr/03-data-plane.md#adr-0032)); Neon/Upstash as **provider adapters** ([ADR-0073](../design/adr/07-portability-extensibility.md#adr-0073)) | ✅/➕ HoBo owns the abstraction; providers are pluggable |
| **Marketplace** (native 3rd-party integrations + unified billing) | provider adapters — **only-registered-considered, auto-generatable** ([ADR-0073](../design/adr/07-portability-extensibility.md#adr-0073)) + generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)) | ➕ on the tech; **✗ on marketplace/usage billing — out of scope by design ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064))** |
| **Vercel AI SDK** (`ai`: generateText/streamText/useChat, tools/agents) | **model/embed ports** + agents-as-principals + inference/token budgets ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ◐/🔜 ports designed; **no shipping AI SDK — Vercel's is the most-adopted TS AI lib** |
| **AI Gateway** (unified model API, spend budgets, observability, fallback, BYOK) | model port + **FinOps budgets/showback** ([Plan 5](../design/reliability-observability-cost.md#plan-05), [ADR-0039](../design/adr/02-identity-security.md#adr-0039)) + Dispatcher budget routing ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ◐ designed; not shipping; **showback only, no token billing** |
| **v0 / v0 Platform API** (text-to-app: prompt→code→deploy) | **AI generation pipeline** + **design.md-driven UI generation** behind `ui-render` port ([Plan 23](../design/generated-stack.md#plan-23), [ADR-0010](../design/adr/03-data-plane.md#adr-0010)/[ADR-0056](../design/adr/03-data-plane.md#adr-0056)) | 🔜 designed; **v0 ships in production, HoBo does not** |
| **Vercel Agent** (PR review, investigations, acts on deploys/logs) | agents-as-principals + MCP + **Operator Crew** ([Plan 6](../design/ai-native-agent-auth.md#plan-06), [Plan 40](../design/operators-sre.md#plan-40)) + governance planes | ◐/🔜 conceptual operator agents; no shipping review/investigation agent |
| **Firewall / WAF / BotID** (managed rulesets, custom rules, invisible CAPTCHA) | security/networking + `domain`/DNS ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035), [Plan 50](../design/security-networking.md#plan-50)) | ◐ designed; Vercel's is a real WAF on a real edge |
| **Active CPU / usage billing** | **FinOps metering + showback, no billing** ([Plan 5](../design/reliability-observability-cost.md#plan-05), [ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗-by-design — showback only ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) |
| **Skew Protection** (runs pinned to creating deployment) | event-sourced version pinning + deterministic replay ([Plan 11](../design/data-plane.md#plan-11)) | ◐ |
| Org/RBAC/SSO/SCIM/Audit Logs | org model + **RBAC/SSO/SCIM** + deny-ceilings ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | ✅ designed |
| *(none — single-vendor)* | **multi-cloud provider adapters + pluggable IaC** ([Plan 4](../design/control-plane.md#plan-04), [ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ |
| *(none — TS/Python-bound)* | **wasm-default polyglot runtime** ([Plan 20](../design/wasm-runtime-wit.md#plan-20), [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ |
| *(none — greenfield)* | **`hobo import`** adopt-in-place migration ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ |
| *(platform vendor-only)* | **self-host = hosted (Yard-is-a-Bindle), OSS** ([Plan 4](../design/control-plane.md#plan-04), [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ➕ |

### What HoBo borrows from Vercel

HoBo deliberately borrows **two** things from Vercel's Workflow SDK ([`vision.md:70`](../design/vision.md#what-hobo-borrows-deliberately)):

1. **The durable `workflow`/`step` ergonomics.** The `"use workflow"` / `"use step"` feel — write ordinary async code, get durability, retries, `sleep`, hooks, and deterministic replay for free — is the DX target for HoBo's durable workflows + sagas ([Plan 11](../design/data-plane.md#plan-11)). HoBo then goes **beyond** by making the *whole* runtime + control plane **event-sourced** (replay, time-travel, audit as first-class), not just per-run durability ([ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
2. **The "Worlds" runtime-ports pattern.** Vercel's insight that a durable runtime is really **event-log + compute + queue behind swappable adapters** is the same shape as HoBo's **WIT ports + provider adapters + wRPC membrane** ([Plan 20](../design/wasm-runtime-wit.md#plan-20), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) — except HoBo applies it to **every** resource and **every** cloud, not just the workflow substrate on one vendor's platform.

Framed respectfully: Vercel proved the durable-execution DX and the pluggable-runtime idea in production; HoBo's contribution is to lift that pattern out of a single frontend cloud into a **cloud-agnostic, wasm-native, self-hostable, event-sourced** control plane.

### The one-line takeaway

**Vercel is the shipping, category-defining Frontend Cloud** — ahead of design-phase HoBo on frontend/edge DX, Next.js gravity, and live AI-app tooling (v0, AI SDK, AI Gateway, Agent) — and the one competitor HoBo openly **borrows from** (durable `workflow`/`step` + "Worlds" runtime ports). HoBo doesn't try to be a better frontend cloud; it **generalizes Vercel's durable-runtime pattern** into a **multi-cloud, wasm-default, self-hostable, event-sourced, agent-native** backend control plane, with usage billing and a revenue Marketplace explicitly **out of scope** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Better-together / integration posture

- **Borrow** — already recorded in [`lineage.md`](../design/lineage.md): the durable
  `workflow`/`step` authoring feel from the Workflow SDK. This capture reaffirms it and adds a
  second: **immutable deployment plus alias promotion** is a cleaner promotion model than most.
- **Benchmark** — preview deployments set the industry expectation; HoBo's ephemeral Camps are
  measured against them.
- **Provider-target** — realistic for web-shaped Bindles.
- Not a displace target: the overlap is real but the buyers differ.

## Threats and lessons

1. **Durable execution has become a platform feature, not a specialist product.** HoBo's
   event-sourced runtime is architecturally deeper, and the authoring feel is what developers
   actually judge — which is precisely why the borrow was recorded.
2. **Preview URLs are the expectation HoBo inherits.** Fourth corpus occurrence of preview
   environments as table stakes.
3. **Framework-adjacent platforms win on integration, not on architecture.** HoBo cannot and should
   not fight there; its ground is targets, not frameworks.
4. **Active-CPU-style billing is a genuine innovation** in serverless economics and a reminder that
   cost models, not just capabilities, are competitive surface.

## Sources

- [vercel.com/docs](https://vercel.com/docs) — projects, deployments, previews, functions, Fluid compute, `vercel.json`, Edge Network, Workflow SDK, AI stack
- [vercel.com](https://vercel.com/) — positioning and pricing (vendor material)
- HoBo-side: [`design/lineage.md`](../design/lineage.md) records the Workflow SDK as a borrow-source

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current AI-stack capabilities and pricing were not re-verified in this
pass and are not asserted.
