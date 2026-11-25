---
type: Competitive Reference
title: "InsForge - Competitor Reference"
description: "InsForge is an agent-native backend-as-a-service: Postgres, auth, storage, realtime, Deno functions, sites, compute, payments, analytics, and an OpenAI-compatible model gateway exposed to coding agents through MCP, CLI, skills, and a dashboard."
tags: [hobo, competitors]
competitor:
  slug: insforge
  name: "InsForge"
  primary_category: backend-data-platforms
  categories: [backend-data-platforms, agentic-infrastructure]
  directness: adjacent
  role: "agent-native backend-as-a-service — agent-ops benchmark and possible provider target"
  posture: [benchmark, provider-target]
  hobo_surface: [agent-surface, typed-contracts]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.insforge.dev/introduction
    - https://github.com/InsForge/InsForge
---

# InsForge - Competitor Reference

> Captured for HoBo competitive analysis (researched 2026-07-01). Sources: [GitHub repo](https://github.com/InsForge/InsForge), [official docs](https://docs.insforge.dev/introduction), [product overview](https://docs.insforge.dev/products), [agent-native docs](https://docs.insforge.dev/agent-native/overview), [pricing](https://insforge.dev/pricing), [changelog](https://insforge.dev/changelogs), and [release v2.2.4](https://github.com/InsForge/InsForge/releases/tag/v2.2.4). InsForge is adjacent to HoBo: it is a batteries-included backend platform built for agents to operate, not a meta-cloud that provisions arbitrary infrastructure. HoBo mapping lives in [HoBo mapping](#primitive-mapping).

## What it is

InsForge positions itself as "the all-in-one, open-source backend platform for agentic coding." In product terms, it is closest to an agent-native Supabase/Convex alternative:

- a hosted or self-hosted backend per project;
- Postgres as the data substrate;
- built-in auth, RLS, storage, realtime, functions, model access, sites, payments, analytics, and compute;
- an MCP server, CLI, skills, VS Code extension, and dashboard so coding agents can read backend state and operate the backend directly.

The strongest distinction is the **operator model**. Supabase and Convex are primarily human-operated backend platforms that also expose APIs. InsForge makes the coding agent the primary operator: the agent fetches schemas, logs, backend metadata, config diffs, advisor findings, and pending migrations; then it applies migrations, deploys functions/sites, configures auth/storage, and diagnoses failures through structured CLI/MCP surfaces.

| Dimension | InsForge |
|---|---|
| Category | Agent-native backend-as-a-service / Supabase alternative |
| Core data | Postgres, PostgREST-style REST, SQL migrations, pgvector, RLS |
| Runtime | Node/Express API + React dashboard + Deno edge-function runtime; PostgREST service in self-host compose |
| Products | Database, Auth, Storage, Realtime, Edge Functions, Model Gateway, Sites, Messaging, Payments, Custom Compute, Analytics |
| Agent surface | MCP server, `@insforge/cli`, skills, VS Code extension, machine-readable metadata/logs/advisor output |
| App SDKs | TypeScript, Swift, Kotlin, REST; OpenAI-compatible Model Gateway |
| Deploy | InsForge Cloud; OSS self-host via Docker Compose/VPS/cloud VM guides |
| License | Apache-2.0 |
| Repo state observed | ~12k stars, ~1k forks, latest release `v2.2.4` on 2026-06-29 |

InsForge is not an infrastructure-from-code system like Nitric or Encore. It does not infer arbitrary cloud resources from app code and map them across clouds. It gives the app a **complete backend envelope** and lets the agent operate that envelope safely.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Postgres core** | The database underneath, as in Supabase |
| **Auth / storage / realtime** | The standard BaaS services |
| **Functions** | Server-side compute |
| **AI gateway** | Model access as a first-class platform service |
| **Agent-facing API** | The distinguishing surface: the platform is designed to be driven by an agent, not only by a console |

The mental model is **a backend an agent can operate**. InsForge's bet is that the consumer of a
backend platform is increasingly a coding agent, and that the API surface should be shaped for that
rather than for a human clicking through a dashboard.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `agent-surface` | **The reason this capture exists** — a BaaS designed for agent operation |
| `typed-contracts` | Schema-derived interfaces |
| `identity-secrets` | Auth as a platform service |

InsForge is **adjacent**: a backend platform and a possible provider target, captured as an
agent-ops benchmark rather than a control-plane rival.

## Feature surface

### Agent-native operation

InsForge's docs split the platform into products and "agent-native initiatives." The latter are the competitive core:

- **MCP server** - exposes InsForge operations as tools that compatible agents can call. The GitHub README says MCP works for both self-hosted and cloud.
- **CLI harness** - `npx @insforge/cli`, deliberately not globally installed, with `--json` for machine-readable results and confirmation flags for noninteractive use. Command areas include login/link, database migrations, config plan/apply/export, branch create/merge/reset/delete, functions, storage, deployments, secrets, schedules, AI, diagnostics, and metadata.
- **Skills** - paired with the cloud CLI so agents can drive setup and operations through repeatable workflows.
- **VS Code extension** - signs in with OAuth + PKCE, selects an org/project, and installs the MCP server into clients such as Cursor, Claude Code, Copilot, Windsurf, Cline, Roo Code, Codex, Trae, and Qoder.
- **Diagnostics and advisor** - `npx @insforge/cli diagnose` returns advisor findings, DB health, metrics, and aggregated logs. Findings include remediation prompts that an agent can apply.
- **Config as code** - `insforge.toml` captures selected project configuration in version control. The CLI supports `config plan`, `config apply`, and `config export`, with env-resolved secrets and dry-run/JSON flows.
- **Backend branching** - creates an isolated child project for risky schema/config work, then merges or resets.

Representative agent loop:

```bash
npx @insforge/cli --json metadata
npx @insforge/cli branch create feat-billing --mode full
npx @insforge/cli db migrations new add-orders-table
npx @insforge/cli db migrations up --all
npx @insforge/cli diagnose --json
npx @insforge/cli branch merge feat-billing --dry-run --save-sql ./preview.sql
npx @insforge/cli branch merge feat-billing
```

This is the part HoBo should take seriously. InsForge is not merely "has an MCP server"; it arranges backend state, drift, logs, diagnosis, config, and migrations as text/JSON surfaces that an agent can run repeatedly.

### Database

Every InsForge project gets Postgres. The docs emphasize:

- **Tables as APIs** - every table becomes REST endpoints plus typed SDK access, without a separate codegen step.
- **SQL migrations** - plain `.sql` files in the repo, applied in order by `npx @insforge/cli db migrations up --all` or MCP.
- **Branching** - branch a backend to test schema changes against copied state.
- **pgvector** - embeddings and vector search inside Postgres, with HNSW and IVFFlat indexes.
- **RLS everywhere** - JWT claims drive Postgres row-level security for database, storage, realtime, and related surfaces.
- **Developer-created schemas** - current changelog notes Data API/dashboard support for non-default Postgres schemas while hiding internal system schemas.

This is a pragmatic Postgres-maximalist backend, closer to Supabase than Convex. It exposes database power directly, but it also inherits the operational shape of Postgres, SQL migrations, and RLS policy authorship.

### Authentication

InsForge Auth covers:

- email/password with verification, password reset, and throttling;
- magic link and six-digit OTP;
- OAuth providers such as Google, GitHub, Apple, Microsoft, GitLab, Discord;
- custom OAuth 2.0 / OIDC providers such as Keycloak, Okta, Auth0, or a private IdP;
- **OAuth server mode**, where InsForge itself is an OAuth 2.0 / OIDC provider for downstream apps;
- JWT sessions consumed by every InsForge product;
- `auth.users` in the project Postgres database, joinable to app tables.

Authorization is deliberately Postgres-centric: RLS policies read JWT claims row by row. This gives one consistent rule surface across database, storage, realtime, and functions, but also means secure app design depends on the quality of SQL/RLS policies.

### Storage

Storage is S3-compatible object storage with:

- signed upload/download URLs;
- bucket-level grouping and public/private buckets;
- row-level policies tied to the same auth JWT;
- direct browser/mobile uploads through presigned URLs;
- compatibility with rclone, AWS CLI, Terraform, and S3 SDKs.

The OSS code tree includes a substantial S3 gateway surface (`CreateBucket`, `PutObject`, multipart upload, CORS, tagging, versioning, listing, `HeadObject`, etc.) plus local and S3 providers. The latest release includes a storage RLS fix around uploads, which hints that S3/RLS composition is an actively hardened boundary.

### Realtime

Realtime is Socket.IO/WebSocket based and covers:

- named channels and wildcard-like patterns such as `order:%`;
- database-triggered messages via a Postgres function such as `realtime.publish(channel, event, payload)`;
- client broadcasts for chat, typing indicators, cursors, and collaboration signals;
- webhook fan-out with retries and delivery counters;
- presence snapshots and join/leave events;
- RLS policies for channel subscription (`SELECT` on `realtime.channels`) and client publish (`INSERT` on `realtime.messages`);
- message history for debugging.

This is not Convex-style deterministic query reactivity. It is event/channel realtime: clients subscribe to channels and receive messages pushed by triggers or clients.

### Edge Functions and schedules

Edge Functions are TypeScript on Deno:

- HTTP endpoint per function at `https://<project>.insforge.dev/functions/<name>`;
- standard `Request`/`Response`, streaming, JSON, redirects, WebSockets;
- cron schedules;
- database triggers on `INSERT`, `UPDATE`, or `DELETE`, with a service-role JWT for privileged follow-up work;
- per-function env vars and secrets;
- structured invocation logs available through dashboard, CLI, or MCP;
- ESM imports from `jsr.io`, `esm.sh`, or `npm:` without bundling or `node_modules`.

InsForge moved edge functions onto Deno Deploy v2 in June 2026. The OSS docker-compose still runs a local Deno service for self-hosted functions, while cloud function hosting depends on InsForge-managed Deno integration.

### Model Gateway

The Model Gateway is an OpenAI-compatible API backed by OpenRouter:

- `/v1/chat/completions`, `/v1/embeddings`, and `/v1/models`;
- server-sent event streaming;
- embeddings intended to land in Postgres/pgvector;
- per-project quotas and spend caps, with clean 429s on limit;
- usage tracking by model, token count, and cost;
- model-name-based routing across OpenAI, Anthropic, Mistral, Llama, Gemini, and others.

This makes InsForge attractive for AI apps: auth, data, file storage, vectors, functions, and model calls are one backend contract instead of several vendor accounts.

### Sites

Sites deploy frontend apps through InsForge-managed Vercel:

- `npx @insforge/cli deployments deploy ./frontend`;
- uploads source while skipping `node_modules`, `.git`, build output, and `.env`;
- Vercel performs framework detection/build;
- dashboard and CLI expose status, deployment history, env vars, cancellation, and syncing;
- ready sites get `https://<appkey>.insforge.site`, optional slugs, and custom domains.

This is convenient, but it is not provider-agnostic hosting. Vercel is the cloud backend for this product.

### Messaging, payments, analytics, web scraping

InsForge goes beyond classic BaaS primitives:

- **Messaging** - transactional email today, with SMS and push on the roadmap; custom SMTP config can be managed through `insforge.toml`.
- **Payments** - Stripe and Razorpay integrations. The API refs show checkout sessions, billing portal, product/price catalog mirrors, subscriptions, transactions, webhook setup/sync, and RLS-aware local tables.
- **Analytics** - PostHog-powered app analytics, including dashboard UI for traffic, retention, and session replay.
- **Web scraper integration** - current changelog notes Apify OAuth integration so agents can pull external data without app-local API keys.

These are product-level integrations rather than infrastructure abstractions. They make InsForge feel more complete for an AI-generated SaaS MVP, but they also concentrate opinionated third-party providers in the platform.

### Custom Compute

Custom Compute runs long-lived containers next to an InsForge project:

- deploy from a Dockerfile or a pre-built image;
- inject project URL, service-role JWT, and S3 credentials;
- configure CPU, memory, and replica count;
- query/tail logs through dashboard, CLI, or MCP;
- set per-service env vars and secrets.

The source tree includes compute providers for cloud and Fly.io, and migration files for compute services. The docs frame Compute as the right fit for workers, background processors, inference loops, WebSocket servers, and scrapers. It is distinct from the core "InsForge Compute" instance that hosts each project's backend and Postgres.

### API, SDK, and code shape

The public docs advertise TypeScript, Swift, Kotlin, and REST. The repository observed on 2026-07-01 is a TypeScript monorepo:

- root workspace packages: `backend`, `frontend`, `packages/*`;
- backend: Node/Express, `pg`, PostgREST integration, Socket.IO, AWS SDK, OpenRouter/OpenAI SDK, Stripe/Razorpay, Zod/shared schemas, node-pg-migrate, Vitest;
- frontend/dashboard: Vite/React, dashboard package, feature modules for auth/database/storage/realtime/functions/logs/payments/analytics/compute/webscraper;
- shared schemas: Zod schemas and API schemas for auth, database, storage, realtime, functions, payments, compute, logs, metadata, deployments, etc.;
- self-host compose: Postgres, PostgREST, InsForge API/dashboard, Deno runtime.

The contract style is REST/SDK/Zod/OpenAPI-ish, not WIT/protobuf/CUE/Pact. That is a major design split from HoBo's boundary standards.

## Deployment, self-hosting, and commercial model

### OSS self-host

InsForge is Apache-2.0 and provides self-hosting guides for VPS, AWS EC2, Azure virtual machines, Google Cloud Compute Engine, and Containarium. The canonical setup is the repo's `deploy/docker-compose/` directory, with Docker Compose bringing up:

- `postgres` (`ghcr.io/insforge/postgres`, with initialization SQL and Postgres config);
- `postgrest` (`postgrest/postgrest`);
- `insforge` app/API/dashboard on port 7130;
- `deno` function runtime on port 7133;
- local volumes for Postgres, logs, storage, Node modules, and Deno cache.

The security guide is unusually candid. It warns that published compose ports should be bound to `127.0.0.1` behind a reverse proxy, because Docker can expose them publicly and bypass UFW. It also says Postgres, PostgREST, the app port, the unused auth port, and the Deno runtime port should not be public in production.

### Cloud and pricing

As of the researched pricing page:

- **Free** - $0/month for prototypes, $1 AI credits, 50k MAU, 500 MB DB, 5 GB bandwidth, 1 GB file storage, 100k edge-function calls, 600 minutes site build time, 120h default custom compute; projects pause after one week inactive.
- **Pro** - $25/month, $10/month InsForge Compute credits, 100k MAU, 8 GB DB, 250 GB bandwidth, 100 GB file storage, unlimited site build time, usage overages.
- **Enterprise** - custom, with SOC2, HIPAA add-on, SSO, unlimited projects, support.
- **InsForge Compute** - each project has a dedicated server for API + Postgres, billed by instance size from Nano ($5/mo) through 16XL ($2,560/mo), with the Pro compute credit applied once per organization.
- **Custom Compute** - separately billed usage for user-deployed containers.

This pricing model reveals the product architecture: one project is not just rows in a shared database; it has an owned compute envelope for the backend/Postgres.

## Architecture

- **Postgres-centred**, with services around it in the now-standard BaaS shape.
- **Agent-first API design** — the differentiator, and the thing to evaluate: whether the surface is
  genuinely designed for programmatic operation or is a conventional API described as agent-ready.
- **State authority** — its own Postgres.
- **Portability boundary** — Postgres underneath helps, as with Supabase; the surrounding services
  and the agent surface are the platform's.

## Where InsForge is stronger

> Shipped, evidenced capability only.


What InsForge does well:

1. **Agent-native backend operations are concrete.** Metadata, logs, migrations, config diffs, branch operations, diagnosis, and remediation prompts are all presented as agent-readable CLI/MCP surfaces.
2. **Batteries-included app backend.** A solo developer or coding agent gets Postgres, auth, storage, realtime, Deno functions, frontend deploys, model access, payments, analytics, and long-running compute in one place.
3. **One identity/security model.** JWT + Postgres RLS flows through database, storage, realtime, and functions.
4. **OpenAI-compatible AI gateway plus pgvector.** AI app primitives are first-class, not a recipe.
5. **Self-hostable under Apache-2.0.** The OSS path is real enough to include Docker Compose, deployment guides, a dashboard, and current Backend Advisor support.
6. **Backend branching for agents.** Isolated backend branches with dry-run SQL merge give agents a safer place to try schema/RLS/config changes.
7. **Pragmatic use of existing systems.** Postgres/PostgREST, S3-compatible APIs, Deno, Vercel, OpenRouter, Stripe/Razorpay, PostHog, Apify: less new theory, more assembled product.

Gaps relative to HoBo's scope:

1. **Not a meta-cloud or IfC planner.** InsForge gives one backend envelope; it does not map arbitrary app resources to AWS/GCP/Azure/Fly/edge/on-prem providers through typed matching rules.
2. **Provider portability is product-specific.** Sites are Vercel-backed, model calls route through OpenRouter, analytics through PostHog, payments through Stripe/Razorpay, compute through platform/Fly-like providers. These are useful integrations, not replaceable provider contracts.
3. **Agent is an operator, not a first-class principal across a capability graph.** InsForge scopes agents through CLI/MCP/API keys and backend permissions. HoBo's design makes agents OIDC/SVID principals with brokered tokens, capability manifests, and audit as substrate.
4. **No event-sourced control plane.** InsForge has logs, diagnostics, and database history; it does not appear to make all platform decisions replayable events with `can-deploy`, policy, cost, and contract gates.
5. **Contracts are REST/Zod/shared-schema oriented.** Strong enough for a BaaS, but not HoBo's protobuf/CUE/Pact/WIT boundary standard.
6. **Branching has explicit boundaries.** Branches copy Postgres/auth/storage/functions/templates/realtime/schedules; docs say compute services and frontend deployments do not branch, quotas are small, and user-data rows are not auto-merged.
7. **Config as code is curated, not complete.** `insforge.toml` covers auth policy, redirect URLs, password rules, SMTP, storage upload size, realtime/schedule retention, and deployment subdomain. Buckets, functions, OAuth credentials, email templates, deployment env vars, and secrets still live elsewhere.
8. **RLS correctness is a sharp edge.** The unified auth model is good, but permissive or wrong Postgres policies are a failure mode; the Advisor helps, but the burden remains close to SQL.

### Comparisons with adjacent tools

| Compared with | InsForge edge | Their edge |
|---|---|---|
| Supabase | Agent-oriented MCP/CLI/skills, model gateway, sites, compute, payments/analytics bundle, backend advisor/remediation prompts | Mature Postgres ecosystem, SQL tooling, edge maturity, larger community |
| Convex | Open Postgres, RLS, S3 compatibility, more conventional SQL/data portability, agent operations | Deterministic reactive queries, serializable function model, typed TS backend consistency, component model |
| Encore | Complete app backend for agents; no need to wire AWS/GCP first | Infrastructure-from-code into user's cloud, app graph, local real-infra DX, typed service/resource model |
| Nitric | Better end-user backend bundle and agent tools | True multi-cloud resource abstraction, provider plugins, `.allow()` -> least-priv IAM, cloud portability |
| Dapr | Higher-level hosted/backend product, auth/storage/data/functions included | Portable runtime building blocks, sidecar/component model, broader platform interoperability |
| HoBo | Shipped-ish agent-operable backend with practical CLI/MCP and app integrations | Meta-cloud, WIT/wasm, event-sourced control plane, Resource Definitions/Matching, agents-as-principals, contract gates |

## Primitive mapping

<a id="hobo-mapping"></a>

> Status vocabulary: `parity` = HoBo has an equivalent design target; `further` = HoBo intentionally goes beyond; `adjacent` = composes with or informs HoBo but is not the same product surface; `gap-pressure` = InsForge raises the execution bar even if the design has an answer.

### Product primitives

| InsForge surface | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Postgres database, migrations, pgvector | `sql`/data-model/data-migration/search/vector ports and paradigm packages | parity/further | [Plan 21](../design/authoring-resources-wiring.md#plan-21), [Plan 32](../design/data-plane.md#plan-32) |
| Tables as REST/SDK APIs | generated WIT clients, typed service APIs, query/search surfaces | further | [Plan 2](../design/sdk-api.md#plan-02), [ADR-0037](../design/adr/01-architecture-core.md#adr-0037) |
| JWT + Postgres RLS | `hobo:auth`, unified principals, policy plane, `.allow()` | parity/further | [Plan 6](../design/ai-native-agent-auth.md#plan-06), [Plan 29](../design/contracts-policy-flags.md#plan-29) |
| S3-compatible storage | `wasi:blobstore` / storage capability providers | parity | [Plan 21](../design/authoring-resources-wiring.md#plan-21), [Plan 20](../design/wasm-runtime-wit.md#plan-20) |
| Realtime channels, presence, webhook fan-out | `Streamer`, reactive query model, event projections, `notify`/webhook-out | parity/further | [Plan 32](../design/data-plane.md#plan-32), [Plan 21](../design/authoring-resources-wiring.md#plan-21) |
| Deno edge functions | wasm components/services, OCI fallback, schedules/triggers | further | [Plan 20](../design/wasm-runtime-wit.md#plan-20), [Plan 2](../design/sdk-api.md#plan-02) |
| Custom Compute containers | OCI container fallback and long-running worker resources | parity | [Plan 20](../design/wasm-runtime-wit.md#plan-20), [Plan 25](../design/platform-engineering.md#plan-25) |
| Sites via Vercel | `web()` resource / frontend hosting capability | adjacent | [Plan 21](../design/authoring-resources-wiring.md#plan-21) |
| Model Gateway | `model`/`embed`/AI capability with cost, policy, and secretless routing | parity/further | [Plan 23](../design/generated-stack.md#plan-23), [Plan 46](../design/governance-planes.md#plan-46) |
| Messaging | `notify` port | parity | [Plan 21](../design/authoring-resources-wiring.md#plan-21) |
| Payments | app integration/resource pack; not HoBo core platform scope | adjacent | [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) |
| Analytics/PostHog | observability/product analytics provider; HoBo run inspector and telemetry are platform-facing | adjacent | [Plan 5](../design/reliability-observability-cost.md#plan-05), [Plan 49](../design/developer-experience.md#plan-49) |

### Agent and operations surfaces

| InsForge surface | HoBo equivalent | Status | Notes |
|---|---|---|---|
| MCP server | `@hobo/mcp` control surface | parity/further | HoBo agents are principals, not just API callers. |
| CLI harness with `--json` | `hobo` CLI + `agent:check`-style machine feedback | gap-pressure | HoBo should match InsForge's "agent reads state, applies change, re-diagnoses" ergonomics. |
| Metadata command | manifest/projection/control-plane query APIs | parity | HoBo must expose real state, not docs-derived guesses. |
| Diagnostics & advisor | run inspector, SRE/incident agents, policy/contract gates | parity/further | InsForge's remediation-prompt UX is a concrete bar. |
| Config as code | HoBo config, Resource Definitions, policy/config packs | further | InsForge covers a subset; HoBo must keep declarative config comprehensive but reviewable. |
| Backend branching | preview Camps, sandbox lanes, deployment Deltas/Sets | further | InsForge validates branch-before-risky-change as agent workflow. |
| Cloud/self-host parity | Yard-is-a-Bindle, signed bundle import, zero-egress profile | further | InsForge self-host is good; HoBo's target is self-host equals hosted control plane. |

### Where HoBo deliberately differs

- **HoBo is a meta-cloud.** InsForge hosts/provides a backend; HoBo chooses and governs resource realization across providers.
- **HoBo is contract-first at boundaries.** InsForge relies on REST, shared Zod schemas, PostgREST, and SDKs. HoBo requires WIT/protobuf/CUE/Pact proof for integration boundaries.
- **HoBo is event-sourced.** InsForge can diagnose and log; HoBo records platform decisions as replayable events and uses them for audit, repair, policy, and cost.
- **HoBo is wasm/WIT-first.** InsForge functions are Deno TS and compute containers. HoBo's portable runtime contract is language-neutral components with OCI fallback.
- **HoBo treats agents as identities.** InsForge makes agents capable operators; HoBo makes them principals with scoped credentials, token brokering, and first-class audit.
- **HoBo should not blindly chase app-SaaS bundles.** InsForge's payments/analytics/webscraper integrations are useful for MVP speed, but HoBo's design scope intentionally avoids becoming an app-business platform. These belong as resource packs/providers unless scope changes.

## Net

InsForge is the most direct pressure on HoBo's **agent-operable backend** story. It does not threaten HoBo's architectural moat around multi-cloud matching, WIT/wasm, event sourcing, and agents-as-principals. It does set a practical bar for first-run agent ergonomics: an agent should be able to fetch current state, branch safely, edit declarative config or migrations, apply, diagnose, read logs/advisor findings, and repair without a human clicking through a dashboard.

For HoBo, the takeaway is not "build Supabase." It is: every HoBo control-plane surface must be as agent-legible as InsForge's CLI/MCP loop, while keeping HoBo's stronger contract, identity, replay, and provider-portability model.

## Adversarial critique

- **"Agent-native" is the easiest claim in this market to make and the hardest to evidence.** An API
  plus documentation is not the same as a surface designed for autonomous operation, and this capture
  does not assert which InsForge has.
- **Small project against very large incumbents** in the same shape (Supabase, Firebase), where
  ecosystem and operational maturity decide adoption.
- **Agent access to a production backend** raises the same authorization question as everywhere in
  this corpus: what bounds what the agent may do, and what records it.
- **Feature breadth against specialists** — auth, storage, realtime and an AI gateway each compete
  with focused products.
- **Category timing risk.** BaaS-for-agents is a bet on how agent development consolidates, which is
  not settled.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Agent actions are bounded by typed contracts and recorded** (*implemented*): HoBo's differentiator
  in this space is not that agents can act, but that what they may do is contractually limited and
  every decision is in the log.
- **Provider-abstract data and auth ports** (*implemented*, ADR-0052/0081) — InsForge is one possible
  realization.
- **Honest caveat.** InsForge ships an agent-facing backend today; HoBo's agent surface is real but
  narrower in the backend-services direction.

## Better-together / integration posture

- **Provider-target** — behind HoBo's data and auth ports.
- **Benchmark** on agent-operability: how much of the platform can be driven correctly without a
  human in the loop.
- Not an adopt, borrow or displace target.

## Threats and lessons

1. **Agent-operability is becoming a product category**, and HoBo's claim must be sharper than
   "agents can call our API" — it is that agent actions are contract-bounded, policy-gated and
   recorded.
2. **The backend layer is consolidating around Postgres**, which strengthens the case for HoBo
   treating Postgres-shaped platforms as interchangeable realizations behind one port.
3. **Claims in this category are cheap.** Evaluating agent-native assertions requires using the
   product, and this capture says so rather than repeating the claim.

## Sources

- [docs.insforge.dev](https://docs.insforge.dev/introduction) and [InsForge/InsForge](https://github.com/InsForge/InsForge) — product surface and source

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Agent-native design claims were not independently evaluated and are
recorded as claims.
