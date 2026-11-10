---
layout: ../../layouts/Docs.astro
title: The trail map
description: "Where HoBo actually is on the road: pre-release, what runs today, and the staged journey from local fidelity to multi-cloud."
---

# The trail map

Where is HoBo on the road? Here's the honest itinerary.

| Area | State |
|---|---|
| **Product** | **Pre-release.** Not accepting tenants; `@hobo/*` packages are **not published to npm** yet. |
| **Developer surface** | SDK primitives, the **canonical `hobo` verb set** (source: `packages/cli/src/shell/verbs.ts`), and the MCP surface documented here are **contract-pinned**: specified, validated, and stable to learn against. Product binary: `@hobo/hobo`; shell/factories: `@hobo/cli`. Interactive authoring is [`hobo-code`](/HoBo/guide/hobo-code/), a different binary. |
| **Implementation** | Progressing through staged build gates (below). Default deploy is an **in-memory Pulumi stand-in**, not live multi-cloud apply. See "What runs today" and ship targets. |
| **This site** | The canonical public developer documentation — for humans and agents. |

Ship targets stay **pre-release**: OSS public docs (this site), local-first developer tooling after a workspace build, hosted beta later. Default apply is an in-memory Pulumi stand-in. See [Getting started](/HoBo/guide/getting-started/) and [Architecture](/HoBo/architecture/) for what a visitor can run without a private repo checkout.

## What runs today

- **The TypeScript bindle flow.** After a workspace build of `@hobo/hobo` and `@hobo/adapter-hono`, a project whose `src/bindle.ts` default-exports a `bindle()` runs `hobo collect`, `hobo plan`, `hobo up`, `hobo down`, and `hobo dev` on the default **local lane** — no cloud account. `@hobo/*` is not on npm (`npx hobo` is the wrong package). Default IaC is an **in-memory Pulumi stand-in** (`HONEST SCOPE` in `@hobo/hobo` compose); a successful `up` does **not** imply real infrastructure was provisioned. A half-built tree used to look like “no Bindle”; import errors now surface. `hobo dev` serves the project's own api/web entrypoint handler in-process; a committed `hobo.bindle.json` manifest artifact wins when present.
- **Durable local EventStore.** The Camp EventStore defaults to a **single-owner SQLite partition** (`@hobo/storage-sqlite` + `@hobo/runtime-local`): stream-head CAS, actor fencing, positioned catch-up, durable subscription checkpoints, and atomic domain events with staged queue/timer/outbox effects. Browser hosts use `@hobo/runtime-browser` with OPFS when available (fail-closed when durable is required but OPFS is not).
- **Contract effects + visible resiliency.** `@hobo/contracts` BoundaryContracts may declare **EffectSpec** and **ResilienceProfile**; can-deploy treats effect widening as breaking when declared; Gatekeeper surfaces effect summaries; `@hobo/contract-harness` isolates pure contracts and runs never-retry fault injection. No Effect-TS/Polly/XState public dependency.
- **Station + pure Conductor.** `@hobo/stations` + `@hobo/broker` — control-plane isolation, Rails, receipts pin `stationId` + `railHash`.
- **Trails + continuous identity.** `@hobo/trails` recipes and hands-off dual-path identity continuous (`@hobo/identity`); pure identity continuous needs zero Trail authoring. **`hobo login` defaults to fixture/local session material**, not production OIDC/SPIRE.
- **Live migration & upgrade executors.** `@hobo/trails` ships upgrade preflight/compatibility evidence, a real expand→backfill→contract executor over SQLite (snapshot-before-mutation, compat-gated destructive contract), pooled→siloed zero-loss tenant moves (fence → drain → export/import → checksum-gated reap), and CDC data-dual ports. The `migration.*` event bodies are pinned in `@hobo/events`' append-only golden-replay corpus with an upcaster-totality gate.
- **Budget-driven routing.** `@hobo/dispatcher` (deterministic credit/budget selection, `dispatch.Decided`), `@hobo/broker` budget threshold signals, and the `@hobo/stations` closed routing control loop + progressive health-gated cutover. `pnpm run staging:cutover` rehearses a zero-downtime backend swap on a loopback lane (archived evidence); Vercel/Cloudflare lanes are credential-gated and fail closed.
- **Jurisdiction & residency.** Typed legal geography in `@hobo/core` (region→jurisdiction catalog, per-tenant residency constraints, fail-closed `evaluateResidency`) with a residency Gatekeeper gate, a residency policy pack, and OSCAL-aligned control→evidence packs in `@hobo/policy`.
- **Thin SaaS providers.** `@hobo/provider-convex` — honestly-scoped capability classes, typed impedance limits, credential-gated Management API (fails closed without a broker-minted key).
- **Harness progressive delivery.** OpenFeature-shaped flag evaluation, delivery, and experiments in `@hobo/identity`; CD apply plane in `@hobo/cloud`.
- **Connectivity foundations.** `@hobo/connectivity` — hierarchical naming (never bare `.hobo`), overlay/DNS, secretless connectors, env isolation, PAM hooks.
- **Messaging.** Unified `topic()` / messaging plane with Kafka and optional Dapr adapters; default remains the local in-process path.
- **Component host scaffolds.** `@hobo/runtime-wasm` (Wasmtime), `@hobo/runtime-oci` (kubectl transport), `@hobo/runtime-cloud-native` (mock default + a **real credential-gated Cloudflare provider** proving the remote FetchHandler contract; aws/gcp/azure/vercel stay declared-unimplemented fail-closed). See [Component hosts](/HoBo/reference/component-hosts/).
- **Componentize honesty.** `@hobo/componentize` has two lanes: the offline default emits **synthetic wasm contract bytes** (`buildWasmContractBytes`) for digest/boundary proofs, and `HOBO_COMPONENTIZE_REAL=1` drives the **real jco/`componentize-js` pipeline** (toolchain-gated, fail-closed — never a silent synthetic fallback) producing genuine component-model binaries.
- **Session Replay on every App Kit.** `@hobo/replay` + default annotation on all App Kits (`api`, `web`, `service`, `ui`, `websocket`, `job`, `wasm-component`) — not only `web` (ADR-0137). Prefer **App Kit** over "membrane type" at Bindle authoring; WIT membrane stays ADR-0069. Local dual fixtures default-on; `hobo dev` wraps HTTP Kits with bootstrap + `/__hobo/replay/*`; production flag/sample gated; `hobo replay *`. See [Session Replay](/HoBo/reference/session-replay/) · [App Kits](/HoBo/primitives/app-kits/).
- **The MCP control surface.** The `hobo-mcp` binary (`@hobo/hobo`) serves the **canonical verb set** as MCP tools over stdio, dispatching through the same command registry as the CLI, with verb/tool parity contract-tested, deny-by-default auth, and audited decisions. See [the MCP surface](/HoBo/agents/mcp/).
- **Login.** `hobo login` runs a real RFC 8628 device-code grant when an issuer is configured (`HOBO_OIDC_ISSUER` → OIDC discovery → device authorization → token polling → JWKS verification), fail-closed with typed remediation; the offline fixture session remains the no-issuer default. `hobo verify` runs the ADR-0146 residency dimension from environment-supplied tenant constraints (`HOBO_RESIDENCY_ALLOW` et al) through the policy layer.
- **Credential-gated live lanes.** Cloudflare and Vercel deploys unlock via env tokens; the real pinned Pulumi engine unlocks via `HOBO_PULUMI_LIVE=1`. These are opt-in; they are not the default offline path.
- **HoBo CI fleet balancing.** `@hobo/ci` holds dated financial models for twelve runner machine classes (the box, a remote ARC scale set, GitHub-hosted, Jog, Boat, Agent37, Depot, Blacksmith, Modal), prices a job through `@hobo/pricing` and the Dispatcher, and admits each candidate through the shared budget policy; the box worker reports host health. Publishing the route table is **off by default, and no workflow reads it yet**; label-routed jobs are not counted against the budget; Agent37, Modal and Boat sandboxes are modelled **without a host driver**. See [HoBo CI](/HoBo/ci/).
- **Examples in the repo:** `hello-bindle` (`hobo up` after adapter build), `multi-cloud-shop` (local Yard kv+queue), `durable-agent` (**tests only**, no Bindle), `self-host-yard` (in-process Yard). Pages [Examples](/HoBo/examples/) ship local-bridge apps; browser-WIT hello-world needs local `astro dev`.
- **Not yet shipped / design-stage:** npm registry publish, full certified multi-cloud provider adapters (fly/aws/azure/gcp production apply paths), Junction package maturity toward S4, production OIDC/SPIRE defaults, and alternate EventStore engines (`runtime-postgres` / Temporal / Restate / Cloudflare DO).

## How the build is staged

One leg at a time:

- **Local toolchain** — hello Bindle through CI with guards green. 
- **Local fidelity** — offline `hobo dev`, replay equals live. 
- **First cloud + Yard** — first provider and drift policy. 
- **Agent autonomy** — scoped agent auth and operator hooks. 
- **Multi-cloud** — overlays, placement across providers, Junctions. 
- **Extensibility** — provider generation and forge hooks. 
- **Production hardening** — HA/DR, canary, FinOps. 

## What “contract-pinned” means

Public surfaces — SDK signatures, CLI verbs, event families — are pinned by executable contracts and conformance suites. Documented examples track the canonical CLI. When this site changes, it is because the **product contract** changed, not because marketing drifted.

## Following along

- [Getting started](/HoBo/guide/getting-started/) 
- [Core concepts](/HoBo/guide/concepts/) 
- [Agent docs](/HoBo/agents/) and [`llms.txt`](/HoBo/llms.txt) 
