---
type: Competitive Reference
title: "Wasp — Competitor Reference"
description: "Wasp (wasp.sh) — a Rails-like full-stack framework for React/Node.js/Prisma driven by a declarative .wasp config; captured as App-Kit inspiration and a packaging path, not a runtime target."
tags: [hobo, competitors]
competitor:
  slug: wasp
  name: "Wasp"
  aliases: ["open saas", "opensaas"]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, backend-data-platforms]
  directness: adjacent
  role: "Rails-like full-stack framework driven by a declarative .wasp spec — App-Kit inspiration and packaging path"
  posture: [borrow, benchmark]
  hobo_surface: [authoring, app-graph]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://wasp.sh/docs
    - https://github.com/wasp-lang/wasp
---

# Wasp — Competitor Reference

> Captured for HoBo competitive analysis; researched August 2026. This file documents
> **Wasp's** offering faithfully; the HoBo↔Wasp mapping/parity tracker lives in the
> [Primitive mapping](#primitive-mapping) section below. Posture per
> [ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144): thin,
> inspirational alignment only — no dual authoring, no runtime embedding.

## What it is

- **Tagline:** *"Develop full-stack web apps without boilerplate."*
- **Paradigm:** a declarative DSL (`main.wasp` / `main.wasp.ts`) describing an app's
  pages, routes, auth, queries/actions, jobs, and email senders — compiled into a
  React + Node.js + Prisma project. "Rails for JS" with the config as the single
  source of app-level intent.
- **Open-SaaS:** a batteries-included SaaS starter (auth, payments via
  Stripe/Lemon Squeezy, admin dashboard, analytics, email, AI examples) built on
  Wasp — the marketing wedge for "a SaaS in a day".

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **`main.wasp` / `main.wasp.ts`** | The declarative app spec — the single source of app-level intent |
| **Entity** | A Prisma model, which is also the database schema |
| **`query` / `action`** | Operations that get an automatically generated, typed client RPC and cache invalidation |
| **`job`** | A cron or background task (pg-boss) |
| **`api`** | A raw Express endpoint, for when the spec is not enough |
| **`app.auth`** | Authentication declared in one place — username/password, email, or OAuth providers |
| **Open-SaaS** | The batteries-included starter kit built on Wasp |

The mental model is **app-level intent as configuration, glue as output**. Wasp's scope is one
application on one stack, and within that scope the compiler removes an enormous amount of
hand-written wiring.

## Feature surface

- **Declarative app spec** — entities (Prisma models), pages/routes, `query`/
  `action` operations with automatic client RPC + cache invalidation, `job`
  (pg-boss cron/background), `api` (raw Express endpoints), `app.auth`
  (username/password, email, Google/GitHub/Discord OAuth) — all wired from the
  spec; the compiler generates the React glue, server plumbing, and typed client.
- **Full-stack type safety** — generated TypeScript types flow from Prisma
  entities through operations into React hooks.
- **Deployment** — `wasp deploy` one-command paths (Fly.io, Railway); `wasp build`
  emits a standard Node.js + static bundle deployable anywhere.
- **Escape hatches** — arbitrary React/Node code beside the spec; the spec stays
  the composition layer rather than a sandbox.

## Architecture

- **Compiler, not runtime.** The `.wasp` spec is compiled into a conventional React + Node + Prisma
  project; there is no Wasp process in production.
- **Generated glue** — typed client hooks, server plumbing, and the RPC layer are emitted from the
  spec, with generated TypeScript types flowing from Prisma entities through operations into React.
- **Escape hatch** — arbitrary React and Node code sits beside the spec, so the spec composes rather
  than sandboxes.
- **Deployment** — `wasp deploy` targets Fly.io and Railway directly; `wasp build` emits a standard
  Node bundle plus static assets that run anywhere.
- **State authority** — Postgres via Prisma.
- **Portability boundary** — good on the way out. Because `wasp build` produces an ordinary Node
  application, leaving Wasp means keeping the generated project. The spec is compiler input, not a
  portable IR, so the *intent* does not travel — only the output does.

## How it competes with HoBo

Wasp is a framework and HoBo is a control plane; the overlap is philosophical rather than commercial.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | Declarative app-level intent producing generated wiring — the same bet HoBo makes with Bindles, at a smaller scope |
| `app-graph` | The spec is a description of the application, though a single-stack one |

Per [ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144) the posture is thin,
inspirational alignment only: no dual authoring, no runtime embedding.

## Where Wasp is stronger
- The declarative-spec-over-framework model proves that **app-level intent as
  config** (auth, jobs, operations declared once, glue generated) removes real
  boilerplate — the same bet HoBo makes with Bindles + IfC, at a smaller scope.
- Open-SaaS shows the value of **opinionated kits**: a curated feature set
  (auth + payments + admin) as one install.

## Where HoBo is stronger or intentionally different

State labels follow the research contract; this capture predates it, so "design-phase" below reads as **design-only** unless otherwise labelled.

- Single stack (React/Node/Prisma), single database (Postgres via Prisma), no
  multi-cloud story, no policy/audit plane, no agent surface; deployment is
  hosted-VM-shaped, not provider-negotiated.
- The `.wasp` spec is compiler input, not a portable IR — no matching, no
  provider equivalence, no event-sourced control plane.

## Adversarial critique

- **One stack, and the stack is the product.** React, Node and Prisma are not choices; a team that
  wants Django or Go is not a customer, which bounds the market by construction.
- **The DSL is a language to learn and to debug.** When generated glue misbehaves, the failure is in
  emitted code the author did not write, which is the classic cost of this approach.
- **Compiler input is not an IR.** The spec cannot be analysed, matched against providers or replayed;
  it exists to produce one project and then its job is done.
- **Deployment is hosted-VM-shaped.** `wasp deploy` names two platforms, and nothing about the model
  reasons over where an application should run.
- **Escape hatches erode the spec's authority.** Raw `api` endpoints and arbitrary code beside the
  spec mean the spec describes some of the application, and the amount shrinks as a codebase ages.
- **Starter-kit gravity.** Open-SaaS is a strong on-ramp and a fork: what a team ships is a snapshot
  of a template, and upstream improvements do not arrive.
- **Small ecosystem** relative to the frameworks it composes, so the long tail of integrations is the
  user's problem.

## Primitive mapping

<a id="hobo-mapping"></a>

> Legend: ✅ parity · ➕ HoBo goes further · ◐ HoBo thinner · 🔜 planned. HoBo is
> design-phase; Wasp ships today — maturity credit is Wasp's.

| Wasp concept | HoBo equivalent | Notes |
|---|---|---|
| `main.wasp` declarative app spec | **Bindle** (TypeScript closure builder, IfC) | ➕ Bindle is provider-agnostic IR with matching + audit, not compiler input ([Plan 25](../design/platform-engineering.md#plan-25)) |
| Entities (Prisma models) | `data` resources + projections | ◐ HoBo's data plane is event-sourced ([Plan 11](../design/data-plane.md#plan-11)); Prisma-style ORM ergonomics are thinner today |
| `query`/`action` + generated RPC | Handlers/operations + generated `_generated/` client ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)) | ✅ same "declare once, typed client for free" bet |
| `job` (cron/background) | `schedule` + `job` resource kinds, durable workflows | ➕ durable, replayable ([Plan 02](../design/sdk-api.md#plan-02)) |
| `app.auth` one-liner | `auth` resource kind + identity plane (SVIDs, OIDC) | ➕ agent principals included ([Plan 06](../design/ai-native-agent-auth.md#plan-06)) |
| Open-SaaS starter kit | **App Kits / Resource Packs** — curated, signed bundles | 🔜 the borrow: ship opinionated kits (auth+payments+admin) as Packs ([Plan 25](../design/platform-engineering.md#plan-25)) |
| `wasp deploy` (Fly/Railway) | `hobo up` with Matching-selected providers | ➕ provider-negotiated, `match.Decided`-audited |
| `wasp build` standard bundle | Packaging path: existing Wasp app via `@hobo/wasp` `waspApp` + `b.web(...)`; deps via OCI containers / external connectors | ✅ one-directional adoption, no dual authoring |

**The borrow HoBo takes:** modular, spec-style feature composition and the
Open-SaaS-shaped kit as **Resource Pack / App Kit inspiration** — higher-level
Bindle kits with curated features, not a second authoring surface.

**Try-site demo:** `/HoBo/examples/` ships real [Open SaaS](https://docs.opensaas.sh/)
under [`examples/wasp-opensaas/`](../../examples/wasp-opensaas/HOBO.md)
(from [wasp-lang/open-saas](https://github.com/wasp-lang/open-saas)), declared as:

```ts
b.web(waspApp("examples/wasp-opensaas/app")).dependsOn(
  b.container({ image: "postgres:16-alpine" }) // or b.external(...)
)
```

Ship resolves that `root` and runs `wasp` there. Optional SaaS deps
(Stripe/S3/email) come from camp / `b.external` connectors — discovered from
`.env.*.example` via `@hobo/wasp` `discoverWaspEnv` per
[Open SaaS deploying](https://docs.opensaas.sh/guides/deploying/).

**Pool** stamps Environment Stations first (Cloudflare Temporary Accounts + CORS
relay `POST /station` — anonymous `*.workers.dev` + claim URL; zero permanent
API tokens; no Bindle in the yard surface). **Ship** places the Wasp app onto
those stations (`wasp build` / Temporary Accounts / Compose realization). Yard
deploy files are station-only (`stationBootstrap`; no `waspApp` / `cli`).
Console URL: `/HoBo/examples/`. Start the bridge with
`pnpm --filter hobo-site run examples:bridge`. Agent-browser feature:
`pnpm --filter hobo-site run examples:regression`.

**The one-line takeaway:** Wasp validates declarative app-level intent and
opinionated kits; HoBo adopts those lessons at the Bindle/Pack layer and offers
existing Wasp apps a packaging path via `@hobo/wasp` — full dual authoring and
generated React glue stay out of scope.

## Better-together / integration posture

- **Borrow** — modular, spec-style feature composition, and the Open-SaaS-shaped kit as **App Kit /
  Resource Pack** inspiration: curated, signed bundles at the Bindle/Pack layer
  ([Plan 25](../design/platform-engineering.md#plan-25), ADR-0145 §2 Distribution).
- **Packaging path** — an existing Wasp app is adoptable one-directionally through `@hobo/wasp`
  (`waspApp` plus `b.web(...)`), with dependencies from OCI containers or `b.external` connectors.
  No dual authoring, and never HoBo-owned Open-SaaS images.
- **Benchmark** on boilerplate removal, where Wasp's result within its scope is excellent.
- Not a displace, provider or render target.

## Threats and lessons

1. **Opinionated kits are a real distribution mechanism.** Open-SaaS sells Wasp far more effectively
   than the DSL does. HoBo's Packs should be curated products with a story, not a registry of parts.
2. **Declared intent must be an IR, not compiler input, if it is to be reasoned about.** Wasp's spec
   generates and stops; HoBo's claim to match, score and replay depends on the description surviving
   as a first-class artifact. That is the actual difference between the two designs.
3. **A clean exit earns adoption.** `wasp build` producing an ordinary Node app is why trying Wasp is
   low-risk — the same argument HoBo makes about deploying through providers' own services.
4. **The escape hatch decides how much of the model is true.** Wasp's raw endpoints and HoBo's
   provider escapes have the same erosion dynamic, and the answer in both cases is to measure the
   escape rather than discourage it (ADR-0144).

## Sources

- [Wasp documentation](https://wasp.sh/docs) — the app spec, entities, operations, jobs, auth, deploy and build
- [wasp-lang/wasp](https://github.com/wasp-lang/wasp) — source
- [Open SaaS](https://docs.opensaas.sh/) and [wasp-lang/open-saas](https://github.com/wasp-lang/open-saas) — the starter kit and its deployment guide
- Related: [Nitric](nitric.md), [Encore](encore.md) and [SST](sst.md) for infrastructure-from-code peers

Pricing (Wasp is open source), current deploy-target list and Open-SaaS feature set were not
verified in this pass and are not asserted.
