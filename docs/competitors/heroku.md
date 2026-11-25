---
type: Competitive Reference
title: "Heroku — competitor reference"
description: "Heroku is the **original developer-first PaaS** (Salesforce-owned since 2010) that popularized `git push heroku main` → a running app, **dynos**, **buildpacks**, **add-ons**, and **config vars**, and authored the **Twelve-Factor App** — now an **AI PaaS** (Managed Inference and Agents, MCP) with a next-gen Kubernetes-based **Fir** generation, but placed in **\"sustaining engineering\"** by Salesforce in Feb 2026."
tags: [hobo, competitors]
competitor:
  slug: heroku
  name: "Heroku"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms]
  directness: overlapping
  role: "the original app-centric PaaS (dynos, buildpacks, add-ons) — the mainstream 'just deploy my app' benchmark"
  posture: [benchmark]
  hobo_surface: [authoring, environments, delivery, ecosystem]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://devcenter.heroku.com/
    - https://www.heroku.com/
---

# Heroku — competitor reference

> A faithful capture of **Heroku** for HoBo competitive analysis. Heroku is the **original developer-first PaaS**: `git push heroku main` builds your repo with a **buildpack** into an immutable **slug** and runs it on **dynos**, with **add-ons**, **config vars**, and **pipelines** wired in — the DX vocabulary most later platforms (Encore, Render, Railway, Fly, Nitric) inherit. Heroku **authored the Twelve-Factor App** methodology and has been **owned by Salesforce since 2010**. It remains a shipping product with a **200+ add-on marketplace**, first-party **Heroku Data** (Postgres/Key-Value/Kafka), a new **AI PaaS** surface (**Managed Inference and Agents**, MCP server hosting, **AppLink** → Salesforce/Agentforce), and a next-generation **Kubernetes-based "Fir"** platform. Two caveats frame the comparison: Heroku is **closed-source** and runs only on **Heroku-operated AWS** (you cannot bring your own cloud or account), and in **Feb 2026 Salesforce moved it into "sustaining engineering"** — freezing new feature development and halting new enterprise sales to redirect investment to enterprise AI. Sources: [heroku.com](https://www.heroku.com/) · [devcenter.heroku.com](https://devcenter.heroku.com/) · [heroku.com/pricing](https://www.heroku.com/pricing/) · [elements.heroku.com](https://elements.heroku.com/addons) · [Managed Inference and Agents](https://www.heroku.com/ai/managed-inference-and-agents/) · [Generations (Cedar vs Fir)](https://devcenter.heroku.com/articles/generations) · status: [The Register](https://www.theregister.com/2026/02/09/heroku_freeze/) / [DevOps.com](https://devops.com/salesforce-freezes-heroku-feature-development-signals-long-term-shift/). **Proprietary, closed-source SaaS PaaS; usage-based pricing (dynos ~$5–$1,500+/mo, add-ons metered on the Heroku invoice); no free tier since Nov 2022.** Researched July 2026; API/CLI/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Heroku is a **fully managed platform-as-a-service** (PaaS): you push code (or a container), Heroku builds and runs it, and you scale by adjusting a **process formation** of **dynos** — lightweight, isolated Linux containers. The developer never touches VMs, load balancers, or orchestrators. The mental model is deliberately narrow and opinionated: declare your process types in a **`Procfile`**, keep configuration in **config vars** (environment variables), attach backing services as **add-ons**, and ship through **pipelines**. This "just push and it runs" experience — launched in 2007 and acquired by Salesforce in 2010 — is the reference point HoBo's "IfC → running app" loop is measured against, and the origin of the **Twelve-Factor App** conventions HoBo's config/secrets-as-references model inherits.

Heroku is now two platform **generations** in parallel. **Cedar** is the mature, 15-year-old runtime (classic buildpacks → slugs, IPv4, HTTP-router stack, the full add-on/pipeline/CI ecosystem). **Fir** — GA in April 2025 but **only via enterprise-only Fir Private Spaces** — is a rebuild on **Kubernetes over AWS** (EKS, **Graviton/ARM64** dynos, Global Accelerator) that uses **Cloud Native Buildpacks exclusively** to produce **OCI images**, is **IPv6-default**, and is **OpenTelemetry-native**. Fir is the future direction, but as of mid-2026 it is still catching up: autoscaling, Heroku CI, the Common Runtime, Docker builds, x86, and monorepo support are all documented as "To Be Added."

The strategic context is unavoidable and material to a competitive read: in **February 2026 Salesforce placed Heroku in a "sustaining engineering model"** — no new feature development, **no new enterprise contracts** for new customers, and staff reductions across Heroku and adjacent units — explicitly to redirect investment toward enterprise AI (Agentforce). Existing customers keep their apps and renewals with no price/service change, but the long-term roadmap is frozen. Heroku is thus simultaneously **the most polished, battle-tested PaaS in this comparison set** and **the one with the most uncertain future**.

| Dimension | Heroku |
|---|---|
| Category | **Original developer-first PaaS** ("`git push` to deploy"); **Salesforce-owned since 2010** |
| Authoring / config | **`Procfile`** process types + **config vars** (env-var config); **authored the Twelve-Factor App** |
| Compute | **Dynos** (isolated containers; process model web/worker/release/clock); tiers **Eco → Basic → Standard → Performance**; Performance = single-tenant + autoscaling; **Private/Shield** dynos in Private Spaces |
| Build | **Classic buildpacks → slug** (Cedar); **Cloud Native Buildpacks → OCI image** (Fir); **Docker via Container Registry** (`container:push`, Cedar) |
| Data | **Heroku Data** — first-party managed **Postgres**, **Key-Value Store (Redis)**, **Apache Kafka** |
| Add-ons | **Elements Marketplace: 200+ third-party managed services**, provisioned by CLI, billed **metered on the Heroku invoice** |
| CD | **Heroku Flow** — **Pipelines** + **Review Apps** + **Heroku CI** + GitHub sync; **instant slug promotion** (no rebuild) + **`heroku rollback`** |
| Generations | **Cedar** (legacy: classic buildpacks, IPv4) · **Fir** (GA Apr 2025, **Private-Spaces-only**; K8s/AWS EKS + Graviton ARM64, **CNB-only**, IPv6/OTel-native; many features "To Be Added") |
| Clouds | **Heroku-operated AWS only** — no bring-your-own cloud/account; **Common Runtime** (multi-tenant) or **Private Spaces** (network-isolated) |
| CLI | **`heroku`** — `git push heroku`; `ps`/`config`/`addons`/`pipelines`/`releases`/`rollback`/`run`/`logs`; **`heroku ai:*`** plugin |
| AI | **Managed Inference and Agents** (GA May 2025; **Bedrock-backed**, OpenAI-compatible; chat/embedding/diffusion; **MCP** + tools/agents); **MCP server hosting**; **AppLink** → Salesforce Flow/Apex/Agentforce |
| License / price | **Proprietary, closed-source**; usage-based (dynos ~$5–$1,500+/mo; add-ons metered); **no free tier since Nov 2022** |
| Status (2026) | **Salesforce "sustaining engineering"** — new-feature freeze + no new enterprise sales (Feb 2026); existing apps continue |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **App** | The unit of deployment and billing |
| **Dyno** | The container the app runs in, sized by type and scaled by count |
| **Buildpack** | The build convention that turns a repository into a runnable slug — now converging on Cloud Native Buildpacks in the **Fir** generation |
| **Add-on** | A third-party managed service attached to an app through a marketplace |
| **Pipeline / review app** | Promotion between stages, with an app per pull request |
| **Config var** | Environment configuration, injected and versioned with releases |
| **Release** | An immutable slug-plus-config pairing, rollback-addressable |

The mental model is the one the whole industry copied: **an app is code plus config plus attached
resources, and `git push` is the deployment interface**. Heroku's durable contribution is not any
feature but the *shape* — the twelve-factor decomposition that made stateless deployment routine.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | Zero configuration: a supported repository deploys with no declaration at all |
| `environments` | Pipelines and review apps |
| `delivery` | Push to deploy, immutable releases, one-command rollback |
| `ecosystem` | **The add-on marketplace** — a two-sided marketplace nobody has replicated at that scale |

Heroku is the benchmark HoBo is measured against implicitly by every developer who has used it, and
the source of the expectations HoBo inherits whether or not it competes for the same buyer.

## Feature surface

### The core loop — Procfile, buildpacks, slugs, dynos

You declare **process types** in a **`Procfile`** at the repo root — an alphanumeric name mapped to a command. The **`web`** process type is special: it is the **only** type that can receive external HTTP traffic from Heroku's routers. Other common types are `worker`, `clock`/scheduler, and the reserved **`release`** phase command that runs once on every deploy (migrations, cache warming):

```procfile
web: bundle exec puma -C config/puma.rb
worker: bundle exec sidekiq
release: bundle exec rails db:migrate
```

Deploy is `git push heroku main`. Heroku's **slug compiler** receives the push, **auto-detects a buildpack** (Ruby/Node/Python/Java/PHP/Go/Clojure/Scala + custom/community), runs `detect → compile → release`, and produces an immutable **slug** (source + fetched dependencies + language runtime + build output). A slug becomes a **release**; releases are immutable and versioned, so `heroku rollback` reverts to a prior release instantly. You scale by setting the **dyno formation**:

```bash
heroku ps:scale web=3 worker=2      # the dyno formation
heroku ps                           # process status
heroku ps:restart                   # cycle dynos
heroku run bash                     # one-off dyno (REPL / rake task)
heroku logs --tail                  # streamed logs
```

On **Fir**, the classic buildpack/slug path is replaced by **Cloud Native Buildpacks** that emit standard **OCI container images** — "the Heroku magic, as a portable container." Docker is also first-class on **Cedar** via the **Container Registry** (`heroku container:push web`, `heroku container:release web`, or a `heroku.yml` manifest), though Fir does not yet support Docker builds.

### Dynos — tiers, sizes, pricing

Dynos are billed **per second, prorated** at monthly-equivalent rates. The tiers (Cedar):

| Dyno | Price/mo | RAM | Notes |
|---|---|---|---|
| **Eco** | **$5** | 0.5 GB | 1,000-hour **shared monthly pool** across all Eco dynos; **sleeps** after 30 min idle |
| **Basic** | **$7** | 0.5 GB | Always-on, single size; no autoscaling/preboot |
| **Standard-1X** | **$25** | 0.5 GB | Multi-tenant; preboot, metrics |
| **Standard-2X** | **$50** | 1 GB | 2× Standard-1X |
| **Performance-M** | **$250** | 2.5 GB | **Single-tenant**, **autoscaling** |
| **Performance-L** | **$500** | 14 GB | Single-tenant, autoscaling |
| **Performance-L-RAM / -XL / -2XL** | **$500 / $750 / $1,500** | 30 / 62 / 126 GB | Larger single-tenant sizes |

**Private/Shield dynos** (network-isolated **Private Spaces**, ~$125–$1,800/mo) add single-tenant runtime + compliance (Shield adds HIPAA/PCI posture). **Fir** dynos are re-tiered (Classic/General-Purpose/Memory/Compute lines, roughly $25–$2,400/mo) and add **GPU dynos** (roadmap). The **free tier was removed in November 2022**.

### Config vars & the Twelve-Factor lineage

Configuration lives outside the codebase as **config vars**, surfaced to the app as **environment variables** — the model Heroku codified as **Factor III (Config)** of the Twelve-Factor App:

```bash
heroku config:set DATABASE_POOL=20 SECRET_KEY_BASE=…
heroku config:get REDIS_URL
heroku config:unset LEGACY_FLAG
```

Add-ons inject their own config vars automatically (e.g. `DATABASE_URL`, `REDIS_URL`), so wiring a backing service is "provision → env var appears."

### Add-ons & the Elements Marketplace

The **Elements Marketplace** lists **200+ add-ons** — managed backing services from third-party **Ecosystem Partners** who fully operate and support them. You provision by CLI; the add-on injects config vars and is **metered on your Heroku invoice** (a single-bill, revenue-share marketplace):

```bash
heroku addons:create heroku-postgresql:standard-0 -a myapp
heroku addons:create heroku-redis:premium-0
heroku addons:create papertrail:choklad          # third-party logging
heroku addons:upgrade heroku-postgresql:premium-2
heroku addons                                     # list attachments
```

First-party **Heroku Data** add-ons anchor the catalog: **Heroku Postgres**, **Heroku Key-Value Store** (Redis-compatible), and **Apache Kafka on Heroku**.

### Heroku Data — Postgres, Key-Value, Kafka

**Heroku Postgres** is the flagship managed database with mature operational features — **forks**, read **followers**, **continuous protection / rollback**, and **Dataclips** (shareable SQL query snapshots). Tiers span **Essential** ($5–$20/mo, shared, ≤32 GB), **Standard** ($50–$12,000/mo, dedicated, ≤8 TB), **Premium** ($200–$24,000/mo, HA + 7-day rollback), and **Advanced** ($150–$40,000/mo, decoupled compute/storage). **Key-Value Store** (Redis) runs $3–$19,600/mo; **Apache Kafka** $100–$13,000/mo. Management is via `heroku pg:*` / `heroku data:pg:*`:

```bash
heroku pg:info
heroku pg:psql
heroku pg:backups:capture
heroku data:pg:create --tier advanced
```

### Pipelines, Review Apps, Heroku CI — "Heroku Flow"

**Heroku Flow** bundles four features into a continuous-delivery workflow:

- **Pipelines** — a group of apps that **share one codebase** across stages (**review → development → staging → production**). Because the compiled **slug is promoted** (not rebuilt), **`heroku pipelines:promote`** from staging to production is **near-instantaneous**.
- **Review Apps** — for a GitHub-connected app, **every open pull request** automatically spins up a **temporary, isolated app** at a unique URL; merging the PR destroys it and (with a pipeline) auto-promotes to staging. Review apps can provision their own ephemeral add-ons (e.g. an `essential-0` Postgres per PR).
- **Heroku CI** — a test runner integrated with pipelines that runs the app's test suite on every push/PR in a disposable environment.
- **GitHub sync** — auto-deploy a branch on push.

```bash
heroku pipelines:create myapp -s production
heroku pipelines:promote -a myapp-staging       # staging → production, instant
heroku reviewapps:enable -p mypipeline
```

### AI PaaS — Managed Inference and Agents, MCP, AppLink

Heroku's newest surface (**Managed Inference and Agents**, GA **May 15, 2025**) reframes it as an **"AI PaaS."** Models run on **Amazon Bedrock** inside Heroku's AWS boundary and are exposed through an **OpenAI-compatible API** across three categories — **chat/language** (e.g. `claude-4-5-sonnet`), **embedding** (e.g. `cohere-embed-multilingual`), **diffusion/image** (e.g. `stable-image-ultra`). You attach models as add-on resources and call them by alias or from the CLI:

```bash
heroku plugins:install @heroku/plugin-ai
heroku addons:create heroku-inference:standard -a myapp            # chat → INFERENCE_KEY/URL
heroku addons:create heroku-inference:standard -a myapp cohere-embed-multilingual --as EMBEDDING
heroku ai:models:list
heroku ai:models:call INFERENCE -a myapp --prompt 'What is 1+2?'

curl $INFERENCE_URL/v1/chat/completions \
  -H "Authorization: Bearer $INFERENCE_KEY" \
  -d '{"model":"claude-4-5-sonnet", ...}'      # /v1/embeddings · /v1/images/generations
```

The **Agents** half adds **MCP** support: Heroku hosts **MCP servers** and lets a hosted LLM **run tools** — with automatic dyno provisioning/deprovisioning for tool execution, retries/error-correction, action traces in the output, and prompt caching. **AppLink** (GA) exposes a Heroku app (in **any language**, described by an **`api-docs.yaml` OpenAPI** file) as native **Salesforce actions** usable from **Flow, Apex, Data Cloud, and Agentforce** — the deep Salesforce-platform tie-in that distinguishes Heroku from every neutral PaaS.

### CLI surface (representative)

```bash
heroku apps:create · apps:destroy · apps:open
heroku ps · ps:scale · ps:restart · ps:exec        # dynos & formation
heroku config:set|get|unset                        # config vars
heroku addons:create|upgrade|destroy               # add-ons
heroku pipelines:create|promote · reviewapps:enable
heroku releases · rollback [VERSION]               # immutable releases
heroku run · logs --tail · domains:add
heroku buildpacks:add · container:push|release · apps:stacks:set
heroku pg:* · data:pg:* · redis:* · kafka:*
heroku ai:models:list|info|call                    # @heroku/plugin-ai
```

## Architecture

- **Control plane** — Salesforce-operated; the customer sees an API, a CLI and a dashboard.
- **Data plane** — Heroku's infrastructure on AWS; dynos are containers on managed capacity.
- **Execution model** — buildpack detection and build, immutable slug, release as slug + config,
  dyno processes scaled horizontally.
- **The Fir generation** moves the platform toward Cloud Native Buildpacks and OCI images, which
  makes the build artifact more standard than the original proprietary slug.
- **State authority** — the platform's own release history, which is genuinely append-only per app
  and is why rollback is trivial.
- **Portability boundary** — the buildpack convention travels (Cloud Native Buildpacks are an open
  standard); the add-on marketplace, dyno model and routing do not.

## Where Heroku is stronger

> Shipped, evidenced capability only.

### what Heroku does well

- **The lowest zero-to-deploy friction in the category, proven over 15+ years.** `git push heroku main` and a `Procfile` is still the gold standard for "code to running app in minutes." Heroku *invented* much of this vocabulary (dynos, buildpacks, slugs, config vars, add-ons) — the DX later platforms imitate.
- **Enormous, mature ecosystem.** A **200+ add-on marketplace** of fully-managed third-party services with single-invoice billing, first-party **Heroku Data** (Postgres/Redis/Kafka) with genuine operational depth (forks, followers, rollback, Dataclips), and a decade-plus of hardened runtime, routing, and support.
- **Operational track record.** Multi-tenant Common Runtime + network-isolated **Private/Shield Spaces**, existing **ISO/SOC** compliance, real incident history and tooling — the kind of production maturity a design-phase platform simply cannot claim.
- **Clean CI/CD story out of the box.** **Heroku Flow** (Pipelines + Review Apps + CI + GitHub sync) with **instant slug promotion** and one-command rollback is coherent and requires zero assembly.
- **Credible AI-PaaS pivot.** **Managed Inference and Agents** (Bedrock-backed, OpenAI-compatible), **MCP server hosting**, and **AppLink → Agentforce** are shipping, not slideware.
- **Cloud-native re-platforming underway.** **Fir** moves to Kubernetes/OCI/CNB with IPv6 + native OpenTelemetry + GPU dynos on the roadmap — a modern foundation.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Heroku's limits — HoBo's opening

- **Closed-source, single-cloud, no BYO account.** Heroku runs **only on Heroku-operated AWS**; you cannot bring your own cloud, your own account, Azure/GCP, edge, or on-prem, and there is **no self-host / open-source core**. HoBo is **cloud-agnostic with pluggable IaC** (Pulumi/Crossplane/Terraform/OpenTofu) and **self-host = hosted parity** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **Frozen roadmap / uncertain future.** Salesforce's **Feb 2026 "sustaining engineering"** move (feature freeze, no new enterprise sales, staff cuts) means the platform's forward investment is redirected to AI — a strategic risk no amount of past polish offsets. HoBo's value is **OSS and self-hostable**, so its continuity does not depend on a single vendor's strategy.
- **Two-generation split with a shallow "new" tier.** **Fir** is GA in name but **Private-Spaces-only**, ARM-only, and missing autoscaling, Heroku CI, Common Runtime, Docker builds, x86, and monorepos ("To Be Added"). The mature path (Cedar) is the *legacy* one. HoBo targets **one coherent runtime** (wasm-default + OCI fallback) across environments ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **No infrastructure-from-code / typed resource wiring.** Backing services are provisioned out-of-band (`addons:create`) and wired by convention (config-var env). There is **no in-code resource declaration, no `.allow()` least-privilege, no manifest/IR** the platform derives from source. This is exactly HoBo's authoring model ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **No platform-rules / same-app-different-infra layer.** A dyno size and an add-on plan are chosen manually per app; there is no auditable "cheap preview vs HA prod realization of the same declaration." HoBo adds **Resource Definitions + Matching** with a recorded `match.Decided` ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) and a credit/budget-aware **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No event-sourced runtime / durable-workflow / audit-replay model.** Releases are immutable and rollback is instant, but there is **no actor/workflow/saga substrate, no time-travel/replay, no audit event store** — you assemble that from add-ons (Kafka + your code). HoBo makes it the runtime ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)).
- **Narrow language/build coupling.** Buildpacks are language-runtime-specific; there is no polyglot **component** model or capability-secured sandboxing. HoBo's contract is **language-neutral WIT / wasm** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).
- **AI story is model-hosting + Salesforce glue, not agents-as-principals.** Managed Inference is an *inference endpoint*; AppLink is *Salesforce-specific* integration. There is **no first-class agent identity, capability manifest, or brokered token model** for agents acting on the platform. HoBo treats **agents as first-class principals** with SVID/OIDC tokens + MCP control ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **No brownfield adoption / portability.** You migrate *onto* Heroku by writing to its conventions; leaving is a rewrite. HoBo's **`hobo import`** adopts existing TF/Pulumi/FaaS estates **in place** ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).

## Adversarial critique

- **Stewardship has been the story for a decade.** Investment slowed markedly after acquisition,
  free tiers were withdrawn, and platform modernization arrived late; the Fir generation is a
  response to competitive pressure rather than a continuation of momentum.
- **Price-to-capability ratio is poor** against every newer entrant in this cohort, which is why they
  all exist.
- **The dyno abstraction is dated.** Fixed sizes and process-count scaling fit 2010-era web apps and
  fit background, GPU, actor and event-driven workloads badly.
- **Add-ons are a dependency surface** the customer does not control: pricing, availability and
  quality belong to third parties reached through Heroku's billing relationship.
- **Single vendor, no BYOC, no self-host** — and unusually for this cohort, no serious pretence
  otherwise.
- **The twelve-factor model encodes assumptions** — stateless processes, attached backing services,
  disposable instances — that are good defaults and quietly exclude whole workload classes.

### Comparisons with adjacent tools

- **vs HoBo:** Heroku is a **closed, single-cloud, commercially-monetized managed PaaS** with unmatched maturity and ecosystem; HoBo is an **open, multi-cloud, IfC + event-sourced + AI-native control plane** you can self-host. Heroku is the **DX benchmark** for zero-to-deploy and the **origin of the Twelve-Factor conventions** HoBo's config/secrets-as-references model ([ADR-0027](../design/adr/02-identity-security.md#adr-0027)) inherits — but it maps one app onto *Heroku's own AWS*, whereas HoBo maps one description onto *any mix of providers*. Heroku's frozen roadmap is the sharpest argument for HoBo's OSS/self-host stance.
- **vs Encore/Nitric:** those are **infrastructure-from-code** frameworks that deploy into *your* cloud; Heroku is the **managed-PaaS incumbent** they explicitly position against on portability and lock-in. Heroku wins on ecosystem/maturity; loses on cloud-agnosticism, IfC, and open-source.
- **vs Render / Railway / Fly.io:** the modern "Heroku successors" compete on price and (Fly) edge/regions; they inherit Heroku's DX vocabulary. HoBo is a different layer — a **meta-cloud control plane**, not another opinionated PaaS runtime.
- **vs Kubernetes/PaaS-on-K8s:** Fir *is* Heroku-on-Kubernetes, but it hides K8s entirely; HoBo orchestrates provisioning across substrates (including K8s via Crossplane) rather than being one runtime.
- **vs Convex/Supabase:** managed backends with a vendor runtime; Heroku is more general-purpose (any process type) but equally a hosted, closed runtime.

**Net:** Heroku is the **most mature and polished platform in this comparison and the one HoBo owes its DX vocabulary to** — but it is **closed-source, single-cloud (Heroku-operated AWS), commercially monetized, and now roadmap-frozen**. HoBo's differentiation is the **entire axis Heroku sits on the far side of**: open-source + self-hostable, cloud-agnostic with pluggable IaC, infrastructure-from-code with typed `.allow()` wiring, an event-sourced durable runtime, a polyglot wasm/WIT contract, platform-rules (Resource Definitions/Matching + Dispatcher), and agents-as-principals — while deliberately **not** replicating Heroku's commercial-monetization machinery (dyno pricing, metered add-on marketplace, revenue share).

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Heroku concept (✅ has · ➕ goes further · ◐ designed-but-shallow · 🔜 planned · ✗ by design). Anchors point at the owning design doc/ADR; where HoBo is thin or unspecified it is marked ◐/🔜, not ✅.

| Heroku concept | HoBo equivalent | Status | Notes |
|---|---|---|---|
| **Dyno** (isolated container, process formation, scaling) | **Camps + `component-host` placement**; wasm-in-container floor, OCI-container fallback ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); HA/autoscaling in the reliability plane ([Plan 5](../design/reliability-observability-cost.md#plan-05)) | ➕ / ◐ | Runtime + placement designed; ➕ polyglot wasm-default. Autoscaling/HA are **designed, unshipped** — Heroku's operational maturity is genuinely ahead |
| **Procfile** process types (`web`/`worker`/`clock`) | IfC service declarations — `web`→`service`/`api` (`hobo:http`), `worker`→component/actor, `clock`→`schedule` port ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | Declared inline instead of a side file |
| Procfile **`release`** phase command | **`can-deploy` contract + release hooks** ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ◐ | Different shape — a gated contract, not a free-form release command |
| **Classic buildpacks / Cloud Native Buildpacks → slug/OCI** | **OCI build pipeline + `component-host`**, wasm-in-container ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ◐ | HoBo builds OCI images and runs wasm-in-container, **but zero-config language auto-detection breadth + the buildpack ecosystem is a real Heroku strength HoBo does not match** |
| `git push heroku` deploy → **immutable release + `rollback`** | **`hobo up` / GitOps** (Operator Crew, [Plan 40](../design/operators-sre.md#plan-40)) + **event-sourced runtime** replay/time-travel ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)) | ✅ / ➕ | ➕ replay/time-travel/audit beyond immutable-release rollback |
| **Config vars** / Twelve-Factor config | **config + secrets-as-references** ([ADR-0027](../design/adr/02-identity-security.md#adr-0027)) + **versioned secret** port ([ADR-0113](../design/adr/02-identity-security.md#adr-0113)) | ✅ / ➕ | HoBo inherits the Twelve-Factor lineage; ➕ versioned/pinned secrets |
| **Add-ons** provisioning model (declare → provision → inject creds) | **resource catalog ports** + `.allow()` + **provider adapters** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ / ➕ | ➕ one `.allow()` → IAM + wasm-cap + token |
| **Elements Marketplace** (200+ third-party managed services, ecosystem partners) | resource ports + provider adapters; **no third-party managed-service marketplace ecosystem** | ◐ | Breadth/partner ecosystem/operational SLAs are **Heroku-ahead**; HoBo has the port shape, not the marketplace |
| Paid add-on **marketplace / metered add-on billing / revenue share** | — | ✗ by design | **✗ by design → [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) (monetization out of scope)** — not a gap HoBo intends to close |
| **Heroku Postgres** (forks/followers/rollback/Dataclips) | **`sql` port** ([ADR-0112](../design/adr/03-data-plane.md#adr-0112)) + **auto-diff migrations** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) + **paradigm packages** `@hobo/sql`/`vector`/`graph`/`document` ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ✅ / ◐ | ➕ broader paradigms; ◐ managed-DB **operational** features (fork/follower/7-day rollback/Dataclips) are **provider-delegated**, not a HoBo product |
| **Heroku Key-Value Store** (Redis) | **`kv` port** (`wasi:keyvalue`) + the new **`cache` port** (ADR-0118, in progress) | ✅ / 🔜 | kv today; app-facing TTL/eviction cache **in progress this tranche** |
| **Apache Kafka on Heroku** | **`topic`/`queue` ports** (`wasi:messaging`) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | Kafka-specific streaming semantics via provider adapter |
| **Pipelines** + **instant slug promotion** (dev→staging→prod) | **Harness** progressive delivery (OpenDelivery) + environment/Camp promotion ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ✅ / ➕ | ➕ OpenFeature/OpenExperiment integrated |
| **Review Apps** (ephemeral per-PR apps) | **ephemeral/preview Camps** ([Plan 25](../design/platform-engineering.md#plan-25)) | ✅ / ➕ | Per-PR isolated environments |
| **`heroku rollback`** (revert release) | **Harness rollback** + **event-sourced replay/time-travel** ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)/[Plan 11](../design/data-plane.md#plan-11)) | ✅ / ➕ | ➕ state-level time-travel, not just artifact revert |
| **Heroku CI** (managed test runner) | external CI/**GitOps** (Operator Crew, [Plan 40](../design/operators-sre.md#plan-40)) + **`hobo verify`** contract gates | ◐ | HoBo does **not** ship a hosted CI product; delegates to GitHub/GitOps + contract verification |
| **Heroku Flow** (Pipelines+CI+ReviewApps+GitHub sync bundle) | Harness + GitOps ([ADR-0083](../design/adr/02-identity-security.md#adr-0083)/[Plan 40](../design/operators-sre.md#plan-40)) | ◐ / ✅ | Composed from planes; no bespoke GitHub-sync product |
| **`heroku` CLI** | **`hobo` CLI** (`dev`/`up`/`down`/`plan`/`verify`) ([Plan 7](../design/developer-experience.md#plan-07)) | ✅ | Heroku's 15-year command breadth/polish is ahead |
| Heroku **Dashboard** | HoBo **dashboard** + operations dashboard / **status pages** ([Plan 7](../design/developer-experience.md#plan-07)/[Plan 49](../design/developer-experience.md#plan-49)) | ✅ / ➕ | ➕ multi-cloud/multi-env fleet view |
| **Managed Inference** (host LLM/embedding/diffusion behind OpenAI-compatible API) | — (no `inference`/model port in the catalog yet) | 🔜 | An inference/model-hosting port is **not yet designed**; genuinely Heroku-ahead. Per-token **billing** is separately ✗ by design → [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) |
| **MCP on Heroku** / agents run tools | **agents as first-class principals** + Capability Manifest + **MCP control surface** + brokered SVID/OIDC tokens ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ✅ / ➕ | ➕ agent identity, deny-by-default capabilities, audited |
| **AppLink** (expose app as Salesforce/Agentforce action via OpenAPI) | neutral analog: MCP/agent-tool exposure + `hobo:http` services ([Plan 6](../design/ai-native-agent-auth.md#plan-06)/[Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ | The **Salesforce-platform binding** (Flow/Apex/Agentforce) is **not a HoBo goal** — not a gap |
| **Private Spaces / Shield** (network isolation + HIPAA/PCI/SOC) | **multi-tenant-app primitives** + security/networking ([Plan 50](../design/security-networking.md#plan-50)/[ADR-0079](../design/adr/02-identity-security.md#adr-0079)/[ADR-0080](../design/adr/02-identity-security.md#adr-0080)) + org/RBAC/SSO ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | ◐ | Network isolation **designed**; but **compliance attestations (SOC/HIPAA/PCI) are operational/commercial**, not a design deliverable HoBo can claim — Heroku-ahead |
| **OpenTelemetry** (Fir-native observability) | **observability (OTel)** + metering/showback ([Plan 5](../design/reliability-observability-cost.md#plan-05)/[ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✅ | OTel-native by design; matches Fir's direction |
| **Salesforce ownership** / closed-source commercial PaaS / **dyno pricing** / metered billing | OSS core; **self-host = hosted ("Yard is a Bindle")** ([Plan 4](../design/control-plane.md#plan-04)); metering = showback, **no billing** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗ by design | **✗ by design → [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)** — HoBo is OSS/self-hostable and does not monetize |
| *(none — deploy-onto-Heroku only)* | **`hobo import`** adopt-in-place brownfield ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ | Adopt existing TF/Pulumi/FaaS estates incrementally |
| *(none — Heroku-operated AWS only)* | **multi-cloud provider adapters + pluggable IaC** (Pulumi/Crossplane/TF/OpenTofu) ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ | One description → any mix of real providers |
| *(none — manual dyno/add-on sizing)* | **Resource Definitions + Matching** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) + cost-routing **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ | Same app → different infra per env, auditable (`match.Decided`) |
| *(none)* | **generation pipeline** — AI-generated providers **and** implementations, conformance-gated ([Plan 23](../design/generated-stack.md#plan-23)) | ➕ | Provider breadth generated, not hand-written |

### The one-line takeaway

**Heroku is the platform HoBo owes its developer-experience vocabulary to** — `git push`-to-deploy, dynos, buildpacks, add-ons, config vars, Twelve-Factor — and it remains **the most mature, ecosystem-rich, operationally proven product in this set**. But it is **closed-source, locked to Heroku-operated AWS, commercially monetized, and (since Feb 2026) roadmap-frozen by Salesforce**. HoBo's opening is the whole axis Heroku sits opposite: **open-source + self-hostable, cloud-agnostic with pluggable IaC, infrastructure-from-code with typed `.allow()` wiring, an event-sourced durable runtime, a polyglot wasm/WIT contract, platform-rules (Resource Definitions/Matching + Dispatcher), and agents-as-principals** — while treating Heroku's dyno pricing, metered add-on marketplace, and revenue share as **✗-by-design non-goals ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064))**, not gaps to close.

## Better-together / integration posture

- **Benchmark**, and the honest framing is *lineage* rather than rivalry:
  [`lineage.md`](../design/lineage.md) already records Heroku as a lesson and lineage source. The
  `cf push` / `git push heroku` ergonomic is the floor HoBo's DX must clear.
- **Borrow** — **the release as an immutable code-plus-config pair with trivial rollback**, and the
  **marketplace shape** for HoBo's Resource/App Packs. Both are proven designs.
- Not a displace, adopt, provider, or render target: Heroku's buyer today is largely inherited
  rather than contested.

## Threats and lessons

1. **Heroku set the expectations HoBo must satisfy** — one command, no configuration, immediate
   result — and it did so fifteen years ago. Anything slower or more ceremonious reads as regression
   regardless of architectural merit.
2. **A two-sided marketplace is a moat nobody in this corpus has rebuilt.** That is a distribution
   lesson for HoBo's pack ecosystem, not a feature to copy.
3. **Platforms decay when stewardship lapses**, and customers remember. HoBo's open core is a
   structural answer to a risk this market has actually experienced.
4. **Immutable release plus rollback is the minimum viable delivery model.** HoBo's event-sourced
   promotion gives this for free and should say so in those terms.

## Sources

- [devcenter.heroku.com](https://devcenter.heroku.com/) — dynos, buildpacks, releases, config vars, pipelines, review apps, add-ons
- [heroku.com](https://www.heroku.com/) — positioning and the Fir generation (vendor material)
- HoBo-side: [`design/lineage.md`](../design/lineage.md) records Heroku as a lesson and lineage source

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current pricing, the Fir rollout state and add-on catalog were not
re-verified in this pass and are not asserted.
