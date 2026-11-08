---
type: Reference
title: "Alchemy parity — plan and task graph"
description: "Task graph T1-T20 mapped to stack layers and draft cascade; gates per task; non-goals with ADR reasons."
tags: [hobo, plans, sdlc, alchemy, parity]
---

# Alchemy parity — plan

Companions: `sdlc-state.md` (decisions, kill-log, stack), `research.md`
(evidence), `issues.md` (one-shot contracts). Parity levels P0–P3 are defined
in `sdlc-state.md`; every task states the level it produces. No task may claim
a level it did not execute.

## Approach (council D + full-breadth P1, user scope = full attempt)

Three approaches were hardened in SDLC 1 (see `sdlc-state.md` kill-log for
rejected A native-per-cloud and un-gated B/C):

- **D (spine):** patterns + distribution + one provider deep to P2.
- **B (gated spike):** `iac-alchemy` behind the IaC port, hard-pinned,
  kill criteria in T13. Never a committed phase until the spike passes.
- **C (deferred):** generation-pipeline codegen target (Plan 23) — no task
  until P1 breadth proves demand for a third live cloud.
- **Full-breadth P1 (user scope):** every remaining Alchemy family reaches P1
  simulated conformance in tranche 1 (T14–T19), then P2 in tranche order
  (T20). Breadth is sequenced, not excluded; labels stay honest meanwhile.

## Task graph

```text
T1 taxonomy ──► T2 conformance spec ──► T3 Cloudflare P2 ──► T4 auth profile
   │                │                       │  │                 │
   ├──► T5 clients  ├──► T11 test harness ◄─┘  ├──► T8 logs      │
   ├──► T6 npm ──► T7 dev watch                │                 ▼
   ├──► T10 cuts                               └──► T12 previews ◄── T9 epic (T3,T4,T6,T7,T8)
   ├──► T14..T19 breadth P1 (each dependsOn T1,T2)
   └──► T13 iac-alchemy spike (dependsOn T3 + user spike gate)
T20 tranche-2 P2 waves (dependsOn T14..T19 + T3 proof)
```

### Layer 01 — contracts/catalog (`sdlc/alchemy-parity-01-taxonomy`)

| ID | Task | Produces | Gate (becomes failing tests first) |
|---|---|---|---|
| T1 | P0–P3 taxonomy in code: parity level per profile/provider in `@hobo/cloud-providers` + live-provider-matrix + `docs/competitors/alchemy.md` refresh to beta.85/86 with honest labels; recount resolver constants (DO/Hetzner/K8s/Hostinger conflicts) by executing them | P0 labels, machine-checked | `pnpm --filter @hobo/cloud-providers test`; matrix test asserts denominator string; `pnpm run docs:competitors:fix` clean |
| T2 | Technical proof (draft skill): extend provider-lifecycle conformance (create/update/replace/delete-idempotent/adopt/crash-resume) with a cred-gated live-lane spec — opt-in nightly only, cost cap + orphan sweep in the contract | P1 contract for all later P2 | `pnpm --filter @hobo/conformance test`; PACT consumer/provider shapes; proof artifacts per `draft:artifacts` |

### Layer 02 — provider realization (`sdlc/alchemy-parity-02-cloudflare-p2`)

| ID | Task | Produces | Gate |
|---|---|---|---|
| T3 | Cloudflare ResourceDefinitions (Workers/Pages/D1/KV/R2/Queues) so composed deploy stops failing closed; live reconcile on cred-gated account | **P2 Cloudflare 6/6 profiles** | T2 six cases live + fake-transport suite green; deterministic-name recovery test; zero-orphan sweep report; impedance rows in PortabilityReport test |
| T4 | Secretless OAuth/profile flow for the default lane (replace raw `CLOUDFLARE_*` env as the documented path); refs only, brokered where possible | P2 enabler | `requireNoPlaintextConformance`; `@hobo/identity` tests; secretless gate (ADR-0027) in `agent:check` |

### Layer 03 — bindings/DX (`sdlc/alchemy-parity-03-bindings-dx`)

| ID | Task | Produces | Gate |
|---|---|---|---|
| T5 | `ctx.bindings` runtime typed-client membrane at init phase (from resolved binding + connectivity projection, ADR-0157/0158) | Bindings-are-SDK, runtime half | `@hobo/runtime-local` tests; `bindles` bind-reference tests; `phase` tests |
| T6 | Technical proof → package change: publish `@hobo/hobo` + `@hobo/bindles` so a clean dir outside the monorepo scaffolds in <1 min | Distribution (P3 step 1–2) | Timed clean-dir smoke script (recorded minutes); `pnpm --filter @hobo/cli test` (new) |
| T7 | `hobo dev` file-watch reload on the local lane (<1 s target); `remote()` analog explicitly deferred behind a follow-up gate | P3 dev step | `dev-verb` tests + timed watch-reload bench in proof |
| T8 | Verify-first logs parity: find/complete `logs` composition; `--tail/--since/--limit/--resource` over Camp streams | P3 logs step | `@hobo/cli` tests; MCP verb/tool parity contract test |

### Layer 04 — epic + patterns (`sdlc/alchemy-parity-04-epic-patterns`)

| ID | Task | Produces | Gate |
|---|---|---|---|
| T9 | Epic proof (draft skill): timed first-day script install→new→dev→up (real Cloudflare URL)→logs→down; executable cucumber features | **P3 measured vs Alchemy getting-started** | Script executed, minutes + step table recorded in proof; unexecuted steps labelled not-parity |
| T10 | Close or permanently relabel ADR-0158/0160/0161 cuts: split WIT init/handler, bundled drizzle SQL emission path, runnable Better Auth server | Removes three "implemented*" asterisks | `adapter-drizzle` + `adapter-better-auth` tests; WIT codegen drift gate; PACT at auth boundary |

### Layer 05 — CI/testing (`sdlc/alchemy-parity-05-ci-testing`)

| ID | Task | Produces | Gate |
|---|---|---|---|
| T11 | Ephemeral-Camp provisioning for `@hobo/testing` (today `HARNESS_LANE_UNIMPLEMENTED`), cred-gated on the T3 lane; event-store deploy caching beyond identity memo | Test.make-class harness, camp-only/real fidelity labels | `@hobo/testing` harness/lanes/readiness tests; fidelity assertion tests |
| T12 | PR-preview recipe: `pr-<n>` Camp via T11, stable bot comment, destroy on close, `check-env` preflight, broker-minted scoped CI credentials as resources | CI pattern parity (mocked GH boundary) | `pnpm test:behavior` (PACT-derived mocks); live run nightly-opt-in only |

### Layer 06 — breadth to P1 (`sdlc/alchemy-parity-06-breadth-p1`)

Each item: profiles/slots where missing + fake-transport resolver + T2 six
cases + PACT + impedance note. **P1 only — no live claim.**

| ID | Family (Alchemy evidence) | HoBo start |
|---|---|---|
| T14 | Missing hosting providers: Fly, Render, PlanetScale; promote Railway into `cloud-providers` with slots/default-yard | Absent ×3; Railway design-only |
| T15 | Big-cloud depth completion to uniform P1: AWS/GCP/Azure unresolved productIds, DO/Hetzner/Hostinger/K8s recount fallout from T1 | Simulated, partial resolvers |
| T16 | Sandbox/agent-compute pattern: one provider-neutral sandbox profile (exec/files/pty/tcp handles) with ≥2 simulated realizations (local OCI + one of Modal/E2B/Daytona-class); watch beta.86 publishing state | Absent (no kind/profile) |
| T17 | Patterns: durable-object product on Cloudflare lane, workflow profile over existing orchestrator/saga machinery, hash-memoized deploy Actions | Actor host local-only; no workflow kind; Actions design-only |
| T18 | Frameworks: detectors/adapters for Next/Astro/Nuxt/SvelteKit/TanStack/Solid as `web.*` realizations (build integration, not new Bindle kinds) | Generic webapp stamps: wasp, convex only |
| T19 | Observability + satellites: OTel-by-default wiring for apps, dashboards/alarms-as-code declarations, Axiom/Sentry exporter targets, AI/vector binding profiles (Workers AI/Bedrock/Vertex-class) behind existing data.vector | Local sink only; rest absent |

Watch items (issue-only/draft upstream — track, do not build): Vercel full
provider and Azure in Alchemy (HoBo already has both natively), Convex-as-
Alchemy-provider, STACKIT, Portless, Netlify-in-Alchemy, Render-in-Alchemy.

### Layer 07 — spike (`sdlc/alchemy-parity-07-spike`)

| ID | Task | Kill criteria (any one kills it, documented) |
|---|---|---|
| T13 | `iac-alchemy` spike: pin `alchemy@2.0.0-beta.85` + `effect@4.1`, Cloudflare bucket+api live reconcile vs the T3 lane, state wrapped by HoBo EventStore | Effect leaks past adapter · plaintext in state/secrets/events · beta.86 breaking churn exceeds shim · no equivalent reconcile result. Time-box 2 weeks. |

### Tranche 2 — P2 waves (T20, stacked after layer 06)

P2-live per provider in order: AWS → GCP → Kubernetes → Azure → Vercel/Netlify
permanent lanes → DO/Hetzner → satellites (Neon semantics gap first). Each
wave is its own issue + stack layer when reached; entry gate is T3's pattern
proving repeatable and a named account/cost owner per cloud.

## Non-goals (ADR-forced, not schedule choices)

- Effect-TS public API (ADR-0136) · provider types in Bindles (ADR-0024/0144)
- Plaintext profile tokens / snapshot-state-as-truth (ADR-0027/0113/0135)
- Schemaless boundaries, stage if-branching (PACT/proto/CUE; ADR-0033)
- Real-cloud tests in PR-default lanes (repo testing policy)
- New Bindle kinds without an ADR + draft-cascade change (T16/T17 must ride
  profiles/ports first; a kind proposal is a separate decision gate)

## Cross-cutting guardrails (every task)

- TS-only new files (`.ts/.tsx/.mts`); protobuf-first records with generated
  types + local `data-models/` CUE; parse-don't-validate at boundaries; PACT
  consumer/provider per integration boundary; CQRS/event-store/actor flows.
- Search before validate; narrow `agent:check -- --staged` per commit;
  package scope before repo scope. Docs freshness in the same change.
- Visual surfaces (CLI/TUI/site getting-started): read the owning DESIGN.md,
  run `pnpm run design:lint` + impeccable critique/audit; designer council at
  closeout for design-relevant layers (03/04 expected).
- Implementers never edit coordinator files (this folder, GAPS.md,
  traceability, registries); they report `cascadeDeltas` in `.sdlc/report.json`.

## Exit criteria for the initiative

1. `sdlc-state.md` parity table: every family ≥ P1 with executed gate output;
   Cloudflare P2 6/6; T9 P3 minutes recorded.
2. Every stack PR squash-merged bottom-up under the Done rule
   (`references/stacked-prs.md`), billing-only CI documented not blocking.
3. `docs/competitors/alchemy.md` + gap-analysis + live-provider-matrix match
   the shipped labels (no checkmark above its evidence level).
