---
type: Reference
title: "Alchemy parity — council research (2026-11-08)"
description: "Evidence base for the Alchemy parity plan: Alchemy current/upcoming, HoBo implemented audit, provider catalog, DX bar. Claims are family-level; unresolved items named."
tags: [hobo, plans, sdlc, alchemy, research]
---

# Alchemy parity — research

Method: SDLC Phase 1 council workflow — five researchers on distinct evidence
surfaces, one adversarial/YAGNI/rubber-duck critic, one synthesis. Each child
was required to open the bodies it cited (web pages, GitHub PR/release bodies,
HoBo implementation + test files). Search hits alone were not evidence.
Decisive values (beta.85 latest, ephemeral-Camp refusal, IaC package set,
provider package set) were re-verified by a second route before planning.

Persona frame (`brainstorm.md`): Dana (app developer, first day), Atlas
(platform engineer, owning Yards/policy), Priya (provider author), Omar
(operator/SRE). Pillars served: portable authoring, honest fidelity,
secretless-first, agent-operability.

## 1. Alchemy shipped delta since 2026-08-19 (beta.74 → beta.85)

- Status alpha → **beta**; install is `alchemy@latest` (2.0.0-beta.85,
  2026-11-02), peer `effect@^4.1.0`. Repo `alchemy-run/alchemy`, Apache-2.0.
- 39 package dirs on main. Published at beta.85 include AWS, Cloudflare, GCP,
  Fly, Hetzner, Railway, Kubernetes, Prisma, Turso, Neon, PlanetScale,
  Axiom, GitHub, Docker, Stripe (now v2), ACME, SQL, Redis, Doppler,
  Infisical, Drizzle, Better Auth, Domain, Test. Sentry/Upstash have **no**
  v2 package (correcting the baseline's v1 satellite list).
- Breadth inside the big three is distilled-SDK scale (src-dir counts —
  upper bounds, per-resource files not each opened): AWS ~200 areas,
  Cloudflare ~110, GCP ~200.
- New families: `@alchemy.run/domain` (DDD aggregates/commands/events/views/
  sagas on Durable Objects; MCP server + Effect-AI tools + ToHttpApi/ToCli —
  application-level, not a control-plane event log); Effect Workflows
  (DO/CF Workflows/Lambda durable); frontend-frameworks ×14 with per-cloud
  `Website.*` adapters; AI bindings (Workers AI, Bedrock/AgentCore, Vertex,
  Vectorize/AutoRAG); deploy-time SQL migrations across Aurora/RDS/DSQL/
  CloudSQL/AlloyDB/Spanner.
- Platform deltas: `drift` command, programmatic `Alchemist` API, Provider
  Contributions (providers ship auth/state/CLI), per-cloud state defaults
  (DynamoDB new AWS default, GCS, CF-DO/SQLite), cross-cloud workload
  identity (GCP↔AWS WIF), interactive TUI, `provider check-env`.
- CI: root GitHub Action; PR previews now stage `staging-{n}` (baseline said
  `pr-{n}`), destroy on close, credentials-as-code confirmed.
- Local dev: workerd/Docker emulation, HMR in ms, `Alchemy.remote()`
  per-resource live opt-in; testing stays real-cloud deploy→assert→destroy,
  `@alchemy.run/test`, default stage `test_$USER`.

## 2. Alchemy upcoming (beta.86, merged-to-main-unreleased at 2026-11-08)

- Verified merged to main, post-beta.85 (npm 404 at beta.85, publishing state
  unresolved): `@alchemy.run/boat`, `/modal`, `/e2b`, `/daytona`, `/archil`
  sandbox providers; `/rivet` (actors/DO/streams, per-cloud control-plane and
  pool Layers); `/effect-cluster` (entities/workflows, swappable DB/pool
  Layers); unified Sandbox handle (`BuildPlan`/`Mount`, exec/files/pty/tcp)
  with provider chosen by Layer; Domain host-as-Layer (Cloudflare DO / Rivet /
  Effect Cluster); `Resource.lookup`, `RemovalPolicy.protect()`, keyless
  Fly→AWS/GCP federation, Docker `build.cache`. 16 breaking (`!`) commits.
- Open, **not** in beta.86: Convex (draft), STACKIT (draft, "nothing has run
  against STACKIT yet"), Portless (non-draft PRs), Vercel full provider
  (old draft) + Vercel DNS, Azure (draft, ~1291 resources claimed).
  Netlify: issue-only. Render: no evidence found.
- No milestones, no GA/beta.86 date, Discussions disabled; imminent is
  inferred from the draft blog PR (#3169, 2026-11-07) and 1–2-week cadence.

Read of the user claim: "many more hosting providers and patterns" is true
for sandbox/host-Layer families; false for Vercel/Netlify/Azure/Render in
beta.86. The plan therefore targets the merged set at P1 and tracks draft
providers as watch items, not parity rows.

## 3. HoBo implemented audit (packages/, not design prose)

Genuinely implemented (code + named tests located; tests not executed in the
research pass; live reconcile never run — all provider evidence is
fake/injected transport):

- Yard binding rows + hard-gate over matching + `binding.Unavailable`
  (ADR-0157): `packages/yards/src/binding.ts`,
  `packages/cloud/src/planner/profile-matching.ts`,
  `packages/bindings/src/resolution.ts`. Seeded localhost Yard exists
  (`packages/yards/src/localhost-seed.ts`); station-init CLI seeding not
  body-inspected.
- Phase primitives plan/init/handle (ADR-0158 core): `packages/core/src/ports/phase.ts`.
  **Split WIT init/handler interfaces absent** (`packages/wit/wit/hobo-sdk.wit`).
- `@hobo/testing` in-process lane + readiness (`untilReady`) + fidelity labels
  (ADR-0159 half). **Ephemeral-Camp provisioning refused**:
  `HARNESS_LANE_UNIMPLEMENTED` (`packages/testing/src/lanes/ephemeral-camp.ts:97`).
- `.allow()` + `ctx.bindings` type derivation in `@hobo/bindles`;
  **per-activation runtime typed-client construction is design-only**
  (`runtime-local` binding resolver returns string values only).
- ResourceResolver reconcile/read/delete/adopt port + Cloudflare resolvers +
  `hobo import`; event-sourced SQLite journal (ADR-0135); provider-lifecycle
  scratch harness, 6 cases, in-memory (`@hobo/conformance`).
- Drizzle diff engine delegates to `@hobo/core` `diffSchemaIr`; **SQL emission
  fail-closed, drizzle-kit not bundled** (ADR-0160 cut).
- Better Auth descriptor over `hobo:data/http/secrets`; **runtime not
  vendored/served** (ADR-0161 cut).

Design-only / absent: CI preview lanes (pr-Camps, destroy-on-close,
broker-minted CI tokens), `remote()`, hash-memoized Actions (saga analog
only), OTel-by-default for apps (local hobo-code sink only),
dashboards/alarms-as-code, `iac-alchemy` (`packages/iac/` = pulumi,
terraform, crossplane only), event-store deploy caching (only an in-process
identity memo exists).

## 4. HoBo provider/pattern denominator

Status key per `docs/design/live-provider-matrix.md` + package bodies.
"Simulated" = slots + fake-transport resolvers; composed deploy fails closed
because no namespace registers ResourceDefinitions
(`packages/cloud-providers/src/index.ts`).

| Provider | Coverage today | Status |
|---|---|---|
| Cloudflare | Workers/Pages/D1/KV/R2/Queues, 6/6 resolvers | Live-anon temp + operator token; resolvers fake-transport |
| AWS | 19 productIds, ~8 SigV4 resolvers | Simulated |
| GCP | 14 productIds, 9 resolved | Simulated |
| Azure | 16 productIds, 9 resolved (ARM) | Simulated |
| Kubernetes | 9 built-ins resolved | Cred-gated/local via injected transport |
| DigitalOcean / Hetzner / Hostinger | 15 / 5 / 5 productIds | Simulated (Hostinger adopt-only delete) |
| Vercel / Netlify | Static deploy + project/site; in first-party catalog | Live (anon-drop lanes; token never on Examples) |
| Neon / Prisma Postgres / Upstash / ttl.sh | Claimable/REST definitions | Live-anon/cred-gated; Neon is a catalog gap (no semantics) |
| Convex / Lakebed | Thin adapters with impedance limits | Cred-gated / live-anon |
| Railway | Equivalence compute/kv/queue only | Design-only (no slots, not in cloud-providers) |
| Fly.io / Render / PlanetScale | — | **Absent** (verified: no packages) |
| Docker/local | OCI + local substrates, SQLite durable Camp | Live-local (default offline lane) |
| GitHub | CI runners/backends, not hosting | Cred-gated CI lane |
| Stripe / Sentry / Axiom | Billing PACT only / none / none | Design-only / absent / absent |

Patterns: Bindle kinds cover api/kv/bucket/queue/topic/secret/data/schedule/
websocket/job/web/service/container/wasm-component/auth/crypto/notify etc.
**Absent as kinds/products:** workflow engine, sandbox/agent-compute, AI
bindings (vector profiles exist abstractly), email/browser/images products,
framework detectors beyond wasp/convex stamps (Next/Astro/Nuxt/SvelteKit/
TanStack/Solid covered only as opaque `web.*` artifacts), Durable Object
productId on Cloudflare (actor host is local/Rivet-runtime only).

Known count conflicts (live-matrix vs `cloud-providers/src/index.ts`:
DigitalOcean, Hetzner, Kubernetes, Hostinger) were not recounted — T1 owns
the recount by executing the constants, not by editing prose.

## 5. DX bar (first day; doc/code bodies, neither flow executed/timed)

Alchemy wins every first-day step except agent onboarding. Root cause is
**distribution + default lane**, not API shape — HoBo Bindle code is
comparably terse:

| Step | Gap | Why |
|---|---|---|
| Install | L | npm add vs clone monorepo + submodules + build (`npx hobo` is another package) |
| Scaffold | M | `hobo new` exists but only on a locally built binary |
| Login | M | OAuth profile vs fixture SVID + raw env tokens on live lanes |
| First resource+binding | M | Shorter HoBo code, heavier noun graph (Bindle/Camp/Yard/Junction/Station) |
| Local dev | L | HMR + `remote()` vs serve with no watch found in `packages/cli` |
| Deploy | L | Real Cloudflare in minute 2 vs local in-memory Pulumi stand-in, no public URL |
| Logs | M | `--since/--limit/--tail/--resource/--stage` vs verb declared, command composition unverified |
| Test | L | `Test.make` real-cloud harness vs contributor-grade contract lanes |
| CI preview | L | Worked `staging-{n}` recipe vs no preview lifecycle found |
| Agent onboarding | HoBo leads | `llms.txt` parity + shipping `hobo-mcp` (42 verbs); Alchemy Domain MCP is app-level |

## 6. Unresolved (carried into the plan, not papered over)

- Alchemy per-resource enumeration not inspected (counts are src-dir upper
  bounds; `llms-full.txt` unfetched; 106 post-beta.85 commits unenumerated).
  Parity rows are therefore family-level; T1 may not mint per-resource rows
  without opening them.
- beta.86/GA dates and the npm-404 reason for sandbox packages unverifiable
  from opened sources at snapshot time.
- HoBo "implemented" = code-present with located tests, not green runs and
  never live. Every implementation task re-runs its gates.
- DX gaps are unexecuted/untimed; T9 is the first timed script. `logs`
  composition in `@hobo/hobo` uninspected — T8 is verify-first.
- Decision inputs outstanding: npm naming, live-lane account/cost owner,
  spike ownership — listed as open gates in `sdlc-state.md`.
