---
type: Competitive Reference
title: "HoBo vs competitors — gap analysis"
description: "Legend: ✅ HoBo designed-for-parity · ➕ HoBo goes further · ◐ designed but shallow/deferred · ✗ gap (not in the design)."
tags: [hobo, competitors]
---

# HoBo vs competitors — gap analysis

> A cross-competitor synthesis: where HoBo's [design suite](../design/index.md) (Plans 0–48) leads, matches, or **falls short** of the full captured set — [Aspire](aspire.md), [Nitric](nitric.md), [Humanitec](humanitec.md), [Nomad](nomad.md) (scheduler pillar displaced — [ADR-0106](../design/adr/01-architecture-core.md#adr-0106)), [Convex](convex.md), [Lakebed](lakebed.md), [InsForge](insforge.md), [Antimetal](antimetal.md), [shoo.dev](shoo.md), [Dapr](dapr.md), [Encore](encore.md), [FinOps tooling](finops-tooling.md), [wasm hosts](wasm-hosts.md), and [NetScaler](netscaler.md). HoBo positions as an **AI-native meta-cloud**, competing head-on with the **Convex / [Lakebed](lakebed.md) / Nitric / [Encore](encore.md)** set ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)). Produced with the [Superpowers](../agent-tooling.md) methodology — **brainstorm → compare → review → iterate**. Companion to each folder's `differentiators.md` (their strengths) and `hobo-mapping.md` (per-feature parity ✅ has / ➕ adds / 🔜 planned).
>
> **➡️ For the current, complete picture jump to [§7 — Corpus-wide adversarial reconciliation (2026-08-20)](#7-corpus-wide-adversarial-reconciliation-2026-08-20--all-86-captures):** all **86** captures, every one written to the [research contract](metadata-contract.md), with three newly-named architecture-level gaps and the adversarial challenges to HoBo's own premises recorded rather than deflected. §6 remains accurate for the 36 captures it scored; §§1–5 are the preserved reasoning trail.
>
> **Superseded pointer — [§6 — Full re-evaluation (refreshed 2026-08-04)](#6-full-re-evaluation-refreshed-2026-08-04--every-capture-vs-hobo):** every one of the **36 captures** scored against the design suite *and the shipped `packages/` workspace as they stand today*, with an honest residual-item ledger. §§1–5 below are the preserved reasoning trail (historical snapshots, markers not current).
>
> **Bottom line (updated 2026-06-22):** the original analysis found the architecture broad with most gaps *tracked* as open questions, one true blind spot (**reactive / live-query**, now Plan 32/ADR-0029), and two designed-but-shallow surfaces (**AI generation**, **search/ingress**). **All of those — and every tracked open question — are now remediated in design** (gaps G1–G8 + open questions #3/#10/#15–20/#22–23, via Plans 32–36 + ADRs 0029–0043). The sections below record the original findings with their ✅ closures inline. **(Re-confirmed 2026-07-03:** all G1–G9 closures hold; the "still-backlogged infra completeness" line at the end of this preamble is **re-classified below** — most of those items were already designed, and the one genuine catalog gap is being closed in the current hardening tranche.)
>
> **Re-survey (post-growth):** the suite has since added the data plane (Plan 39), Operator Agents/the Crew (Plan 40), the generated infrastructure stack (Plan 41), patchability (Plan 43), and SRE incident management (Plan 44) — ADRs through 0058. *(App/UI generation remains in scope per the [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) keep list — UX Designer, design.md, OpenUI, json-render, mcp-apps, and the `ui-render` port.)* A fresh competitor + docs/technologies/standards re-survey found **no new material gaps**: every competitor strength maps to a Plan (✅/➕), every captured standard/tool is adopted-at-the-boundary or deliberately kept behind a port, and the last named candidate (**G9 — app-facing crypto**) is now closed (`hobo:crypto`, below). Remaining items are explicit iteration hooks (multi-agent negotiation, derivative-upgrade tooling, on-call rotation), not gaps.
>
> **Hardening additions (ADRs 0066–0068) — *not* gap closures.** Three cross-cutting architecture additions firm up existing planes: **cost-driven graceful degradation** (availability *through* cost controls — the `costAvailabilityProfile` + spend-velocity-driven QoS shedding, [ADR-0039](../design/adr/02-identity-security.md#adr-0039)), **component-host portability conformance** (the `component-host` becomes a conformance-gated, version-pinned portability boundary + a PortabilityReport scorecard, [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)), and **derivative upgrade paths** (closes the deferred patchability-upgrade iteration hook, [ADR-0057](../design/adr/07-portability-extensibility.md#adr-0057)). All compose existing machinery (policy/Planner/conformance/events), no new runtime.
>
> **Scope expansion (Plans 45–48, ADRs 0059–0062) — *not* gap closures.** A subsequent "more complete design" sweep deliberately *broadened* the suite into greenfield a complete platform needs but that no competitor-comparison surfaced as a gap: the **`notify` port** (`notify`/email/sms/push/webhook-out as a cloud-messaging port in the catalog — [Plan 21](../design/authoring-resources-wiring.md#plan-21)/[ADR-0059](../design/adr/03-data-plane.md#adr-0059)), a **compliance & data-governance plane** (classification→enforced residency/retention, crypto-shred erasure, an OCSF attestation export — [Plan 46](../design/governance-planes.md#plan-46)), **AI safety & model governance** (model registry, output guardrails, red-teaming — [Plan 46](../design/governance-planes.md#plan-46)), and **Registry distribution** (publish→discover→install→trust over signed/certified artifacts, never gating portability, no monetization — [ADR-0062](../design/adr/07-portability-extensibility.md#adr-0062)). Each is built over existing machinery (ports/policy/events/conformance/Registry), not new runtime. These are *new surface area*, recorded here so the matrix isn't mistaken for the platform's full scope; the **competitive** gap backlog remains fully closed. **Out of scope** (AI-native meta-cloud refocus, [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)): SaaS-business functions (billing/monetization/FinOps *automation* as a business product) only — app/UI generation stays in the ADR-0064 keep list. **Infra-completeness re-classification (2026-07-03):** the items once backlogged here are largely designed already — **hosted org/tenancy + SSO/SCIM** ([organization-workspace-model](../design/organization-workspace-model.md), [member-rbac-administration](../design/member-rbac-administration.md), [tenant-isolation-quotas](../design/tenant-isolation-quotas.md); SSO/SCIM + deny-ceilings via [ADR-0074](../design/adr/02-identity-security.md#adr-0074)) and **BCDR** ([backup-restore](../design/backup-restore.md), [teardown-recovery](../design/teardown-recovery.md) + the multi-region-DR/control-plane-HA proofs) are covered; **realtime collaboration** has its substrate (reactor [ADR-0050](../design/adr/03-data-plane.md#adr-0050) + `websocket()` rooms) with only a first-class presence primitive open; **API-management** has route security ([ADR-0114](../design/adr/02-identity-security.md#adr-0114)) + rate-limiting, with per-consumer keys/usage-plans still thin. The one genuine catalog gap — an **app-facing `cache` port** (CDN itself is already covered via `web()`) — is now closed by [ADR-0118](../design/adr/03-data-plane.md#adr-0118); realtime-presence is disposed by [ADR-0119](../design/adr/03-data-plane.md#adr-0119) (composes from `websocket` rooms + reactor + `cache`) and per-consumer API-key/usage-plan management by [ADR-0120](../design/adr/02-identity-security.md#adr-0120), both over existing machinery. Monetized API products stay **out** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## 1. Comparison matrix

> **Historical snapshot (2026-06-22) — markers not current.** The ◐/✗ cells record the original analysis; capabilities later closed in design are marked ✅ inline in §3/§5 and mapped in the [historical open-question ledger](../design/generated-stack.md#historical-open-question-ledger). Preserved as the reasoning trail, not as current state.

Legend: ✅ HoBo designed-for-parity · ➕ HoBo goes further · ◐ designed but shallow/deferred · ✗ gap (not in the design).

| Dimension | Aspire | Nitric | Humanitec | Convex | **HoBo (Plans)** |
|---|---|---|---|---|---|
| Code-first composition / wiring | ✅ | ✅ | — | ✅ | ✅ Bindle + IfC ([21](../design/authoring-resources-wiring.md#plan-21)/[22](../design/authoring-resources-wiring.md#plan-21)) |
| Infrastructure-from-Code (`.allow()` least-priv) | — | ✅ | — | — | ➕ triple-effect `.allow()` (IAM+wasm-cap+token) ([21](../design/authoring-resources-wiring.md#plan-21)) |
| Multi-cloud portability (same app → N clouds) | ✗ | ✅ | ◐ (K8s) | ✗ | ➕ Camps + ADR-0028 ([03](../design/control-plane.md#plan-04)) |
| Resource Definitions + Matching (platform rules) | — | — | ✅ | — | ✅➕ auditable `match.Decided` ([25](../design/platform-engineering.md#plan-25)) ◐ *algorithm open ([Q3](../design/generated-stack.md#historical-open-question-ledger))* |
| Deployment Sets / Deltas / promote | — | — | ✅ | ◐ | ✅➕ event-sourced ([26](../design/platform-engineering.md#plan-25)) |
| Durable workflows / actors / sagas | — | ✗ | — | ◐ (txns) | ➕ ([02](../design/sdk-api.md#plan-02)/[11](../design/data-plane.md#plan-11)) |
| **Reactive client queries / live subscriptions** | — | — | — | **✅ (core)** | **✗ NEW GAP → [Q21](../design/generated-stack.md#historical-open-question-ledger)** |
| Generated typed clients / codegen | ✅ | ◐ | — | ✅ | ✅➕ WIT-generated ([24](../design/wasm-runtime-wit.md#plan-20)) ◐ *SDK codegen surface thin* |
| Vector / full-text search | — | — | — | ✅ | ◐ `vector` port exists, surface undetailed ([21](../design/authoring-resources-wiring.md#plan-21)) |
| SQL + migrations workflow | — | ✅ (`.up.sql`) | ◐ (preview) | n/a | ◐ port designed, migration DSL deferred ([Q15](../design/generated-stack.md#historical-open-question-ledger)) |
| Local-dev parity + dev dashboard | ✅ (`aspire run`) | ✅ | — | ✅ | ◐ `hobo dev` ([15](../design/developer-experience.md#plan-07)) *fidelity open ([Q17](../design/generated-stack.md#historical-open-question-ledger))* |
| Multi-language (non-TS) authoring | ✅ (.NET+poly) | ✅ (membrane) | lang-agnostic | ✗ (TS) | ◐ wasm/WIT spine, non-TS IfC deferred ([Q12](../design/generated-stack.md#historical-open-question-ledger)) |
| AI-generated providers/impls (generation pipeline) | ✗ | ✗ | ✗ | ✗ | ➕ unique — generation pipeline now specified ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) |
| Agents as first-class principals | ✗ | ✗ | ✗ | ✗ | ➕ unique ([06](../design/ai-native-agent-auth.md#plan-06)) |
| Event-sourced audit / replay / time-travel | ✗ | ✗ | ◐ | ◐ | ➕ unique core bet ([11](../design/data-plane.md#plan-11)/[14](../design/reliability-observability-cost.md#plan-05)) |
| Air-gapped / sovereign deploy | — | — | ✅ | ◐ (self-host) | ✅ zero-egress Yard profile + signed bundle import + in-boundary trust roots ([ADR-0036](../design/adr/07-portability-extensibility.md#adr-0036)/[28](../design/platform-engineering.md#plan-25)) |
| Enterprise governance (RBAC/approvals/drift) | ✗ | ◐ | ✅ | ◐ | ✅ ([12](../design/security-networking.md#plan-12)/[28](../design/platform-engineering.md#plan-25)/[30](../design/contracts-policy-flags.md#plan-29)) |
| End-user (human) auth broker | — | — | — | ◐ | ✗ orthogonal (HoBo does *agent/workload* identity; pairs with shoo) |
| Self-host = hosted | ✗ | ✅ (OSS) | ◐ | ✅ (OSS) | ➕ Yard-is-a-Bindle ([04](../design/control-plane.md#plan-04)) |

**Reading:** HoBo's ➕ columns (multi-cloud + IfC + durable runtime + event-sourcing + agents/generation pipeline in one model) are the moat no single competitor matches. The ◐/✗ rows are where competitors are ahead or HoBo is thin.

## 2. Brainstorm — sharp questions that surface the gaps
*(Superpowers `brainstorming` style: challenge the design's assumptions, one pointed question each.)*

> **Historical framing — all resolved.** The questions below were the *open* probes at analysis time; each is now answered in design (see the ✅ closures in §3 and the ADR/Plan links). They're preserved as the reasoning trail, not as current open items.

1. **Reactivity:** HoBo has a `Streamer` port and an event log — but a Convex user gets `useQuery()` that re-runs and pushes to every client on write, with consistent snapshots. *What is HoBo's client-facing live-query story?* Is it "bring your own websocket over `Streamer`", or a first-class reactive-query model with cache-invalidation + consistency guarantees? Today: **undefined.**
2. **generation pipeline depth:** Plans 6/23 say generation pipeline *generates* providers/impls and gates them by conformance. *But what actually generates them?* The conformance gate ([09](../design/generated-stack.md#plan-09)) is specified; the generation loop (inputs, prompt/program synthesis, repair iteration, the training-engine for impls) is thin outside [Plan 23](../design/generated-stack.md#plan-23)'s `use training`. *Is "generation pipeline generates providers" demonstrable, or aspirational?*
3. **Matching credibility:** ✅ **RESOLVED → [ADR-0033](../design/adr/01-architecture-core.md#adr-0033)** ([Q3](../design/generated-stack.md#historical-open-question-ledger) + ADR-P4): selection on the deploy path is **deterministic rules** (filter on `require` → rank lexicographically [specificity → `priority` → configurable objective, default min-cost → stable tiebreak] → record full ranking in `match.Decided`); constraint-solvers/LLMs are **advisory only, off-path**. Deterministic + replayable + auditable — the credibility property prod needs, and more transparent than Humanitec's opaque selection.
4. **wasm to prod:** ✅ **RESOLVED → [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)** ([Q10](../design/generated-stack.md#historical-open-question-ledger)): a **`component-host` port** (the host is a property of a Camp), **Wasmtime** locally, **wasm-in-container** as the portable v1 prod default (reuses the OCI pipeline → runs anywhere a container runs), and **SpinKube / wasmCloud-lattice / provider-native** as opt-in per-Camp adapters. "wasm-first" now has a concrete substrate.
5. **Data, not just infra:** ✅ **RESOLVED → [Plan 32](../design/data-plane.md#plan-32)** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)): declarative-schema + auto-diff migrations, gated **expand/backfill/contract** apply + snapshot rollback, and **export→import within a provider equivalence class** for cross-cloud moves ([Q15](../design/generated-stack.md#historical-open-question-ledger); v1 = relational `sql`/Postgres). The multi-cloud promise now covers *data*, not just infra.
6. **Batteries vs Lego:** Convex is one consistent backend; HoBo is ports→providers (compose-it-yourself, per cloud). *Does the agnostic Lego model cost too much first-run DX vs Convex's batteries?* Mitigations: a "starter Resource Pack" + great `hobo dev`.

## 3. Gaps — prioritized
### A. NEW (no existing plan or open question)
- **G1 — Reactive / live-query data model (Convex).** ✅ **CLOSED → [Plan 32](../design/data-plane.md#plan-32)** ([ADR-0050](../design/adr/03-data-plane.md#adr-0050)): a `query()`/`"use query"` primitive + event-log **reactor** (hybrid: native projections default, opt-in provider DB **change-feed** capability), **per-query consistent snapshot @ `seq`** + reads-your-writes, client `useQuery()`. Was the one true blind spot; designed via brainstorming + grill-with-docs.
- **G8 — End-user / application auth surface (shoo / Convex Auth / Clerk / Auth0).** ✅ **CLOSED → [Plan 6](../design/ai-native-agent-auth.md#plan-06)** ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)): a **federate + verify** `auth()` port (`hobo:auth`) validating OIDC/JWT from any IdP (Google/GitHub/Clerk/Auth0/customJwt) via the existing JWKS machinery + a thin dev built-in; a **unified principal model** (end-user = `PrincipalRef`, `ctx.user`, authz via the same policy plane + `.allow()`, same event audit); **stateless JWKS verify + event-sourced sessions** for revocation; `useAuth()`/`signIn`/`signOut`. *(Identified by the 2026-06-22 re-survey; not in the original analysis.)*
- **G2 — Vector & full-text search surface (Convex).** ✅ **CLOSED → [Plan 32](../design/data-plane.md#plan-32)** ([ADR-0034](../design/adr/03-data-plane.md#adr-0034)): a first-class unified **`search` port** (full-text + vector + hybrid/RRF) behind a provider equivalence class (pgvector+PG-FTS ↔ OpenSearch/Azure AI Search/Pinecone), declarative migration-gated indexes, determinism-split reactivity (full-text reactive, vector = step), and a secretless **`embed`** capability (local/hosted, BYO escape hatch). Closes [Q22](../design/generated-stack.md#historical-open-question-ledger).

### B. Designed-but-shallow (deepen an existing plan)
- **G3 — generation pipeline *generation* pipeline.** ✅ **CLOSED → [Plan 23](../design/generated-stack.md#plan-23)** ([ADR-0010](../design/adr/03-data-plane.md#adr-0010)): the **scaffold → LLM-fill → validate(sandboxed, no-egress) → repair(via `training-engine`, bounded) → certify(signed provenance)** loop, **contract-first** inputs (WIT + conformance + Capability Manifest authoritative; docs/OpenAPI sanitized hints), unified across **providers + implementations + Resource Definitions/Packs**. The unique differentiator is now specified end-to-end (was the least-detailed).
- **G4 — Custom domains + ingress depth** (Nitric has custom domains): ✅ **CLOSED → [ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)** ([Plan 12](../design/security-networking.md#plan-12) §Custom domains): a first-class **Yard-level `domain`** fronting member Camps, **policy-driven DNS routing** (failover/weighted/latency via a `dns` capability), **ACME DNS-01** secretless certs (provider-managed adapter). HoBo goes beyond single-cloud custom domains to a real **multi-cloud ingress** story. Closes [Q23](../design/generated-stack.md#historical-open-question-ledger).
- **G5 — SQL migration DSL** (Nitric `.up.sql`, Humanitec preview): ✅ **CLOSED → [Plan 32](../design/data-plane.md#plan-32)** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) — folded into the data-migration work: **declarative desired-schema + auto-diff** (raw `.up.sql`-style SQL is the escape hatch), gated expand/backfill/contract apply + snapshot rollback.
- **G6 — Air-gapped / sovereign mode** (Humanitec): ✅ **CLOSED → [ADR-0036](../design/adr/07-portability-extensibility.md#adr-0036)** ([Plan 25](../design/platform-engineering.md#plan-25) §Air-gapped): beyond the connected-private HoBo Relay, a first-class **zero-egress Yard profile** — **signed offline bundle import** (same trust boundary), **in-boundary trust roots** (Identity/internal-CA/KMS) + **local models with graceful degradation**, no phone-home, and a capability-degradation matrix. The deterministic core works with no egress. Multi-Yard **federation** is designed as the **Junction** ([ADR-0043](../design/adr/07-portability-extensibility.md#adr-0043), [Q20](../design/generated-stack.md#historical-open-question-ledger)); an air-gapped Yard may stand alone or join a Junction.
- **G7 — SDK codegen surface** (Aspire/Convex typed end-to-end): ✅ **CLOSED → [ADR-0037](../design/adr/01-architecture-core.md#adr-0037)** ([Plan 2 §Generated code](../design/sdk-api.md#plan-02)): a **checked-in `_generated/`** directory generated deterministically from WIT interfaces (jco) + Zod + `.allow()` + the bindle graph (typed `ctx.bindings`, `useQuery`/search, workflow/step sigs, `api` tree), run in `hobo dev`/`build` with a **`hobo codegen --check`** CI drift gate + MCP parity. The codegen DX is now shown, not just promised.

### C. Already tracked (competitor-confirmed priorities — see the [historical open-question ledger](../design/generated-stack.md#historical-open-question-ledger))

> **Historical snapshot** — statuses as of the original analysis; strikethrough+✅ rows were closed later. Current status per ID: the ledger.

| Gap | Competitor pressure | Open Q |
|---|---|---|
| ~~Local-dev fidelity~~ ✅ ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) + dev dashboard | Aspire | [#17](../design/generated-stack.md#historical-open-question-ledger) |
| Non-TS IfC parity | Nitric | [#12](../design/generated-stack.md#historical-open-question-ledger) |
| ~~Matching algorithm choice~~ ✅ ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) | Humanitec | [#3](../design/generated-stack.md#historical-open-question-ledger) |
| ~~wasm host-of-record for prod~~ ✅ ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | all (clear runtimes) | [#10](../design/generated-stack.md#historical-open-question-ledger) |
| ~~Cross-Camp stateful consistency~~ ✅ ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) | (multi-cloud premise) | [#16](../design/generated-stack.md#historical-open-question-ledger) |
| ~~App-data schema evolution & migration~~ ✅ ([Plan 32](../design/data-plane.md#plan-32)) | Nitric/Humanitec | [#15](../design/generated-stack.md#historical-open-question-ledger) |
| ~~Billing / quota / runaway-spend~~ ✅ ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | Humanitec (governance) | [#18](../design/generated-stack.md#historical-open-question-ledger) |

## 3b. Re-survey — Dapr & Encore (2026-06-22)
After the backlog closed, two of the closest **un-captured** comparables were added (see [`dapr/`](dapr.md), [`encore/`](encore.md)) and analyzed against HoBo's now-complete design:

- **Dapr** ([`dapr/`](dapr.md)) — the closest *architectural* analog: portable building-block APIs with pluggable components behind them. Its 12 building blocks map **near 1:1** onto HoBo's WIT ports/primitives — strong external **validation** of HoBo's ports/capability-provider spine. Dapr stops at the **runtime/sidecar** layer (it doesn't provision infra, has no control-plane planes, no event-sourced audit, hand-written adapters). **No new major gap** — HoBo is a superset (provisioning + control plane + AI-native) on top of the same runtime model.
- **Encore** ([`encore/`](encore.md)) — the closest *product* analog: infrastructure-from-code for TS/Go → AWS/GCP, with excellent local DX (`encore run` real-infra + `:9400` dashboard + preview envs) and an MCP agent surface. It **validates** HoBo's IfC authoring (Plans 21/22), local-fidelity (ADR-0042), preview-Camps (Plan 26), and MCP (Plan 6). It's bounded to **AWS/GCP + TS/Go + fixed mapping**; HoBo's breadth (multi-cloud + pluggable IaC + language-neutral wasm + Resource Definitions/Matching + event-sourced governance + generation pipeline) is the delta. **No new major gap.**

**Minor candidates surfaced (low priority, not a remediation round):**
- **G9 — first-class app-facing `crypto` capability** (Dapr's *cryptography* building block: encrypt/decrypt/sign with keys the app never holds): ✅ **CLOSED → `hobo:crypto`** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 31 §App-facing crypto](../design/authoring-resources-wiring.md#plan-21)) — `encrypt`/`decrypt`/`sign`/`verify` with **brokered key handles the app never holds** (KMS/Key Vault/Cloud KMS/in-boundary HSM behind the port), the same secretless guarantee as tokens.
- **Minor — explicit app-facing `lock()` primitive + declarative per-binding resiliency policies** (Dapr exposes distributed-lock + retry/timeout/circuit-breaker config). HoBo *has* the mechanisms (ActorHost lease, [Plan 5](../design/reliability-observability-cost.md#plan-05) circuit-breakers/retries) but not as app-declared surface; exposing them is a small DX add. *Low priority.* **Mostly subsumed:** the common "serialize writes to this entity" case is now the **aggregate boundary** — an aggregate is an actor's single-writer lease ([ADR-0053](../design/adr/03-data-plane.md#adr-0053)), so you model the entity as an aggregate rather than reaching for a lock. A standalone `lock()` is only needed for **cross-aggregate / cross-resource** critical sections (the residual minor DX add).

**Net:** the two closest comparables surface **no major new gaps** — they primarily *validate* HoBo's architecture, with a couple of minor additive capabilities worth a future tranche if demand appears.

## 3c. Re-survey — InsForge (2026-07-01)
[`InsForge`](insforge.md) is the strongest captured pressure on HoBo's **agent-operable backend** story: it packages Postgres, auth, storage, realtime, Deno functions, sites, compute, payments, analytics, and an OpenAI-compatible model gateway behind an MCP/CLI/skills/dashboard loop that coding agents can drive. It is adjacent rather than head-on: InsForge is a batteries-included backend-as-a-service, while HoBo is an AI-native meta-cloud.

**No new major architecture gap.** InsForge's shipped surfaces map to existing HoBo design:

- **Agent backend operation** maps to `@hobo/mcp`, agents-as-principals, brokered tokens, and control-plane query/projection APIs ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **Backend branching** maps to preview Camps, sandbox lanes, and Deployment Sets/Deltas ([Plan 25](../design/platform-engineering.md#plan-25)).
- **Config as code** maps to Resource Definitions, policy packs, and versioned HoBo config ([Plan 21](../design/authoring-resources-wiring.md#plan-21), [Plan 29](../design/contracts-policy-flags.md#plan-29)).
- **Postgres/RLS/storage/realtime/functions/model-gateway** map to existing data, auth, blobstore, notify/realtime, wasm/OCI runtime, and model/embed ports ([Plan 21](../design/authoring-resources-wiring.md#plan-21), [Plan 32](../design/data-plane.md#plan-32), [Plan 46](../design/governance-planes.md#plan-46)).

**Execution pressure added:** HoBo's design already goes further architecturally, but InsForge sets a practical DX bar: an agent should be able to fetch current backend state, branch safely, edit migrations/config, apply, diagnose, read logs/advisor findings, and repair without dashboard clicks. That is not a new Plan, but it should harden the acceptance criteria for HoBo CLI/MCP/projection work.

**Deliberate non-gap:** InsForge's payments, analytics, and web-scraper integrations make it compelling for AI-generated SaaS MVPs. HoBo should keep those as provider/resource-pack opportunities unless product scope changes; ADR-0064 keeps app-business functions outside the platform core.

## 3d. Re-survey - Antimetal (2026-07-01)
[`Antimetal`](antimetal.md) is the strongest captured pressure on HoBo's **operator-agent/SRE** story: it connects to production tools, builds a live world model, investigates incidents, produces evidence-backed RCA/fix artifacts, and hands remediation to humans or coding agents through MCP, skills, API, draft PRs, and "open in agent" flows. It is adjacent rather than head-on: Antimetal operates over existing production estates, while HoBo is an AI-native meta-cloud that owns planning, deployment, policy, contracts, events, and patches.

**No new major architecture gap.** Antimetal's shipped surfaces map to existing HoBo design:

- **Production issue lifecycle and triage** map to Operator Agents, the Crew, SRE incident workflows, SLO/error-budget/cost observability, and event-sourced incident records ([Plan 40](../design/operators-sre.md#plan-40), [SRE deep-dive](../design/operators-sre.md#sre-incident-management-runbooks--self-healing), [Plan 5](../design/reliability-observability-cost.md#plan-05)).
- **World model and evidence-backed RCA** map to HoBo's resource graph, Bindle/Camp/Yard model, event store, materialized projections, deployment sets, policy decisions, and replayable audit history ([Plan 11](../design/data-plane.md#plan-11), [Plan 25](../design/platform-engineering.md#plan-25), [generated stack](../design/generated-stack.md#plan-23)).
- **MCP/coding-agent handoff** maps to agents-as-principals, brokered credentials, `@hobo/mcp`, and control-plane query/projection tools ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **Fix proposals and draft PRs** map to patchability, derivative upgrades, generated repair loops, conformance gates, and PR/check discipline ([ADR-0057](../design/adr/07-portability-extensibility.md#adr-0057), [Plan 23](../design/generated-stack.md#plan-23)).
- **Security/data-boundary pressure** maps to HoBo's Relay/Yard/zero-egress profiles, signed bundle import, in-boundary trust roots, and local-model degradation paths ([ADR-0036](../design/adr/07-portability-extensibility.md#adr-0036)).

**Execution pressure added:** Antimetal sets a concrete product bar for operator agents: an agent should open or receive a production issue, gather evidence across telemetry/deploys/code/incidents/policy history, present an inspectable RCA with causal graph/timeline/artifacts, propose remediations behind approval gates, and hand the fix to Codex/Cursor/other agents or a PR. HoBo should carry its stronger contract/type/test/policy gates into that fix artifact, especially because Antimetal's docs say its generated fixes do not run tests or builds.

**Deliberate non-gap:** Antimetal's broad integration catalog is valuable, but it is not a new HoBo core plane. HoBo should normalize external telemetry and incident tools behind provider/port boundaries while differentiating on canonical deploy-time authority, event-sourced governance, and sovereign in-boundary operation.

## 3e. Survey — FinOps tooling (2026-07-02)

[`FinOps tooling landscape`](finops-tooling.md) captures Kubecost/OpenCost, Infracost, Vantage, and Cast.ai — adjacent showback/optimization products that validate demand for cost visibility without replacing a control plane.

**No new major architecture gap.** The landscape confirms existing HoBo FinOps design:

- **Runtime allocation (Kubecost/OpenCost)** maps to `MeteringView`, OpenCost-shaped showback, and FOCUS export at the boundary ([ADR-0039](../design/adr/02-identity-security.md#adr-0039), [`focus-opencost.md`](../standards/focus-opencost.md)).
- **Plan-time cost (Infracost)** maps to Planner cost estimates and deploy gates ([Plan 5](../design/reliability-observability-cost.md#plan-05)).
- **Multi-cloud dashboards (Vantage)** maps to FinX attribution over event-sourced deploy history ([finops-budget-routing-control-plane](../design/finops-budget-routing-control-plane.md#product-surfaces)).
- **Automated optimization (Cast.ai)** maps to cost-driven degradation tiers and credit-aware Dispatcher routing ([ADR-0039](../design/adr/02-identity-security.md#adr-0039), [ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).

**Known gaps unchanged:** The tooling survey does not add new architecture gaps beyond those already tracked in [`GAPS.md`](../../GAPS.md). FinOps advisory computation ([ADR-0115](../design/adr/02-identity-security.md#adr-0115)) and FinOps Crew ownership ([ADR-0117](../design/adr/03-data-plane.md#adr-0117)) are designed on main.

**Differentiation confirmed:** HoBo embeds metering, quota enforcement, showback, and cost-aware placement in the same event-sourced platform that plans deployments — these tools bolt onto billing exports or clusters after the fact.

## 3f. Re-survey — mainstream PaaS + future-competitor backlog (2026-07-03)

The captured set expanded from 14 to 32: the **mainstream developer-PaaS cohort** ([Heroku](heroku.md), [Render](render.md), [Railway](railway.md), [Fly.io](flyio.md), [Vercel](vercel.md), [Netlify](netlify.md), [Modal](modal.md), [AWS Amplify](aws-amplify.md)) — the products an end user actually compares "just deploy my app" against, previously a blind spot — plus the repo's own future backlog ([wasmCloud](wasmcloud.md), [Spin/Fermyon](spin-fermyon.md), [Winglang](winglang.md), [SST](sst.md), [Qovery](qovery.md), [Northflank](northflank.md), [Backstage](backstage.md), [Crossplane](crossplane.md), [Radius](radius.md), [Supabase](supabase.md), [ServerKit](serverkit.md)).

**No new architecture gap** — with two small items surfaced and closed in this same pass:
- **App-facing cache.** Encore/Vercel/Railway/Render/Fly each expose an ephemeral Redis-class cache as a distinct primitive; HoBo had folded caching into the durable `kv`/`data`. Closed by the new **`cache` port ([ADR-0118](../design/adr/03-data-plane.md#adr-0118))**, which also corrected the latent `kv`-conflation overclaim.
- **Realtime presence.** Supabase ships first-class Realtime **Presence**; HoBo had the substrate (reactor + websocket rooms) but no presence primitive. Disposed by **[ADR-0119](../design/adr/03-data-plane.md#adr-0119)** (composes from rooms + reactor + the new `cache` port; `@hobo/presence` is an opt-in package).

**The honest through-line — execution, not architecture.** These are **shipping products** with real scale, ecosystems, and polish; HoBo is **design-phase**. Where a capture marks a competitor ahead, it is on shipping maturity (Heroku/Render/Railway managed-ops polish, Fly's global edge + Firecracker microVMs, Modal's serverless GPU + agent sandboxes, Vercel's frontend/edge DX + shipped AI tooling, Supabase's Postgres depth + Realtime Presence, Backstage's 140+-plugin portal, Crossplane/Radius CNCF maturity) — **not** a hole in the design. Several entries are **adopted substrates or borrow-sources**, not rivals: wasmCloud is HoBo's default host ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)), SpinKube a `component-host` adapter, Crossplane a pluggable-IaC adapter + reconciliation borrow ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)), Radius a recipes/app-model borrow, Backstage a complementary portal that could surface a HoBo Yard.

**Deliberate non-gaps.** Every PaaS in the cohort monetizes (metered billing, add-on marketplaces, paid tiers); those cells are **✗ by design** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)), not gaps. SST-on-Pulumi validates HoBo's **IaC-under-IfC** thesis; Encore/Amplify/Nitric/Wing validate the **IfC authoring model**; Winglang (Wing Cloud shut down 2025) is a cautionary tale reinforcing HoBo's OSS + self-host = hosted stance.

**Net:** the moat — agnostic WIT ports + pluggable IaC + a wasm-default polyglot runtime + a durable event-sourced runtime + auditable Matching/Dispatcher + agents-as-principals + generation pipeline, self-hostable — remains uncontested by any single competitor in the expanded set. The competitive risk is **shipping the design**, not a missing capability.

## 3g. Re-survey — SST (2026-07-03)

[`SST`](sst.md) joins Encore/Nitric as the closest pressure on HoBo's **IfC-authoring + IaC-substrate + local-DX** story. It is a close product analog but adjacent in ambition: an **AWS-centric Infrastructure-from-Code framework** (one `sst.config.ts`) whose v3 "Ion" engine runs on **Pulumi + Terraform** (150+ providers), with typed resource **Linking**, **Live-Lambda** local dev, and an optional **Console** — where HoBo is an agnostic, AI-native meta-cloud. Its v3 rewrite (CDK/CloudFormation → Pulumi/TF) also **dated the old landscape row** in [`vision.md`](../design/vision.md), now corrected.

**No new major architecture gap.** SST's shipped surfaces map to existing HoBo design:

- **Pulumi/Terraform engine** maps to `iac-pulumi` (primary) + Crossplane/OpenTofu adapters **behind a port** — HoBo keeps the engine swappable rather than welded ([Plan 4](../design/control-plane.md#plan-04), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069)).
- **Resource Linking + the typed `Resource` SDK** maps to triple-effect `.allow()` (IAM + wasm-cap + agent-token) and checked-in `_generated/` bindings ([Plan 21](../design/authoring-resources-wiring.md#plan-21), [ADR-0037](../design/adr/01-architecture-core.md#adr-0037)).
- **High-level components** map to WIT ports with cross-cloud equivalence classes ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); the raw Pulumi/TF escape hatch maps to `.with(...)` ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **`sst dev` Live-Lambda** maps to `hobo dev` + the fidelity matrix ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)); **state/"Home"** maps to the event-sourced control plane ([Plan 11](../design/data-plane.md#plan-11)); **Console/Autodeploy + preview envs** map to the dashboard, Deployment Sets/Deltas, and preview Camps ([Plan 7](../design/developer-experience.md#plan-07), [Plan 25](../design/platform-engineering.md#plan-25)).
- **Auth/Secret/Router/Realtime** map to `hobo:auth` ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)), `hobo:secrets`, Yard-level `domain` ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)), and `hobo:websocket` ([ADR-0075](../design/adr/07-portability-extensibility.md#adr-0075)).

**Execution pressure added:** SST sets a concrete DX bar HoBo's acceptance criteria should meet — **Live-Lambda local↔cloud fidelity** (real invocations proxied to local, `<10ms` reload, real IAM in the loop), **one-line full-stack framework deploys** (a Next.js app ≈ 70 low-level resources hidden), and **typed multi-language resource linking** (JS/TS/Python/Go/Rust). These are not new Plans, but `hobo dev`'s Camp-only tier and the `_generated/` linking DX should be held to this bar.

**Deliberate non-gap:** SST's "150+ providers" is **multi-*provider*, not multi-*cloud-portable*** — the portable high-level components are AWS-centric, and the long tail is raw provider-specific resources. HoBo differentiates on genuinely portable ports + pluggable IaC + event-sourced governance + AI-native operation; SST's breadth is a validation of the Pulumi/TF substrate, not a new HoBo core plane.

**Net:** like Dapr/Encore, SST surfaces **no major new gap** — it primarily *validates* HoBo's Pulumi/TF substrate, typed-linking DX, and local-first-with-real-cloud-fidelity bets, while its AWS-centric IaC framing is exactly the breadth/AI-native delta HoBo is built to fill.

## 3h. Re-survey — Alchemy (2026-08-17)

[`Alchemy`](alchemy.md) (alchemy.run) joins SST/Encore/Nitric as the sharpest pressure yet on HoBo's **authoring + provisioning core** — and, unusually, as a **candidate component**. It is a TypeScript-native, **engine-less** IaC library (no Pulumi/TF/CFN — providers are Effect Layers calling cloud HTTPS APIs directly), embeddable in any JS runtime, v2 rebranded **"Infrastructure-as-Effects"** on the Effect library; Apache-2.0, alpha, AWS + Cloudflare deep, with **LLM-authored providers** as the explicit ecosystem strategy.

**No new major architecture gap.** Alchemy's shipped surfaces map to existing HoBo design:

- **Engine-less direct-API provisioning** maps to the IaC port ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) — and doubles as a 🔌 opportunity: a **candidate `iac-alchemy` engine adapter** (embeddable, pure-TS, Apache-2.0) beside `iac-pulumi`/`iac-terraform`/`iac-crossplane`, attacking the in-memory-stand-in caveat ([live-provider-matrix](../design/live-provider-matrix.md), H-E5) on the Cloudflare/AWS lanes.
- **Convergent `reconcile` + `read` recovery + `--adopt`** map to the borrowed Crossplane reconcile model ([Plan 4](../design/control-plane.md#plan-04)) and per-resource adoption within `hobo import`'s scope ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **Bindings-are-the-SDK** (capability-granular typed clients deriving IAM) maps to triple-effect `.allow()` + `_generated/` ([Plan 21](../design/authoring-resources-wiring.md#plan-21), [ADR-0037](../design/adr/01-architecture-core.md#adr-0037)).
- **Effect Layers / tagged errors** map ↔ to HoBo's deliberate opposite: declarative `EffectSpec`/`ResilienceProfile` as contract data with **no Effect-TS public dependency** ([ADR-0136](../design/adr/03-data-plane-effects-resiliency.md)) — library-level vs contract-level effect typing.
- **LLM-authored providers + `llms.txt`** map to the generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)) — Alchemy ships the generation half with **no validate/certify half**; HoBo's conformance-gated pipeline is the complement, and Alchemy-provider-shaped Layers are a plausible **codegen target**.

**Execution pressure added:** Alchemy raises the shipped bar on four surfaces at once — workerd-fidelity local dev with per-resource local/remote routing (`Alchemy.remote()`), real-cloud deploy→assert→destroy testing with per-PR resource copies, **credentials-as-code** CI (scoped tokens/OIDC minted by the stack), and OTel-by-default with dashboards/alarms-as-code. All land on the standing §6.4 theme (first-run fidelity), sharpened.

**Deliberate non-gap:** Alchemy has **no portability model, no governance planes, no event-sourced audit, no agent identity, no polyglot runtime** — and its un-bundling philosophy suggests it never will. That is the "engine, not control plane" line: HoBo should position *for* Alchemy's thesis (it validates deleting the monolithic engine) and treat Alchemy-using teams hitting the second-cloud/compliance/audit wall as qualified adopters, not competitors' users.

**Net:** the strongest validation yet of two HoBo bets at once — un-bundle the IaC engine, and grow providers by LLM — plus a live **compose-don't-compete** option (`iac-alchemy`). Risks to that option are recorded in the capture: alpha churn (v1→v2 rewrote the whole authoring model), Effect-welded public surface, ~$1.06M viability (Winglang cautionary tale), Cloudflare gravity.

**Design response (2026-08-17, same tranche):** rather than leaving these as execution bars, the Alchemy-surfaced seams were integrated into the design suite as **ADR-0157–0161** (narrative: [`yard-bindings.md`](../design/yard-bindings.md)) — the Yard as capability→product **binding authority** with a seeded localhost Yard on Station init ([ADR-0157](../design/adr/07-portability-extensibility.md#adr-0157)), `plan`/`init`/`handle` **deployment phases** ([ADR-0158](../design/adr/01-architecture-core.md#adr-0158)), the **OOB test harness + credentials-as-code CI lanes** closing GAP-026 ([ADR-0159](../design/adr/07-portability-extensibility.md#adr-0159)), and **drizzle-kit / Better Auth defaults** ([ADR-0160](../design/adr/03-data-plane.md#adr-0160)/[ADR-0161](../design/adr/02-identity-security.md#adr-0161)). The §6.4 first-run-fidelity theme keeps the *proof* obligation; the *design* obligation is closed.

## 4. Review verdict
*(Superpowers `receiving-code-review` framing.)* **Strong-but-uneven** *(original verdict)*. HoBo's intersection bet (agnostic IfC + durable event-sourced runtime + agents/generation pipeline, self-hostable) is genuinely uncontested — no competitor spans it. The risks were **depth, not breadth**: (a) the **unique** differentiator (AI generation) was the least-specified; (b) HoBo lacked the one piece of mainstream DX a TS-backend audience expects (**reactive queries**); (c) several "designed" capabilities were blocked on unresolved open questions (wasm host, matching algorithm, data migration) that competitors had already shipped answers to. None fatal; all addressable in the design phase.

> **Update — depth gaps closed.** Every prioritized gap is now designed end-to-end via interactive brainstorm + ADR: reactive queries (**G1** → Plan 32/ADR-0029), AI generation (**G3** → Plan 33/ADR-0030), wasm host-of-record (**Q10** → ADR-0031), app-data migration (**G5/Q15** → Plan 34/ADR-0032), Matching algorithm (**Q3/ADR-P4** → ADR-0033), search/vector (**G2/Q22** → Plan 35/ADR-0034), custom-domains/ingress (**G4/Q23** → ADR-0035), air-gap/sovereign (**G6** → ADR-0036), and SDK codegen (**G7** → ADR-0037). The "depth" critique is resolved; the intersection bet now has the specified substance to back it. Remaining work is the deferred operational/federation questions (#16/#18/#19/#20), not competitive gaps.

## 5. Iterate — recommended next design moves (priority order)
1. **Design the reactive/live-query model** (G1) — close the Convex DX gap; new plan candidate, built on `Streamer` + projections.
2. **Deepen the generation pipeline** (G3) — make the headline differentiator concrete (extend [23](../design/generated-stack.md#plan-23)/[06](../design/ai-native-agent-auth.md#plan-06)).
3. ✅ **Resolved wasm host-of-record** ([Q10](../design/generated-stack.md#historical-open-question-ledger) → [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) — `component-host` port; Wasmtime local + wasm-in-container default + per-Camp host adapters unblock "wasm-first" for prod.
4. ✅ **Designed app-data schema evolution + migration** ([Q15](../design/generated-stack.md#historical-open-question-ledger) → [Plan 32](../design/data-plane.md#plan-32)/[ADR-0032](../design/adr/03-data-plane.md#adr-0032)) — the multi-cloud promise now covers data: declarative-diff migrations, expand/contract gating, intra-equivalence-class moves.
5. ✅ **Decided the Matching algorithm** ([Q3](../design/generated-stack.md#historical-open-question-ledger) → [ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) — deterministic filter→rank→tiebreak + configurable cost-default objective; makes Resource Definitions credible + auditable vs Humanitec's opaque selection.
6. ✅ **All competitive gaps G1–G8 closed** (reactive G1, generation pipeline-gen G3, search G2, domains G4, SQL-migration G5, air-gap G6, SDK-codegen G7, end-user-auth G8 — see §3), **plus every tracked operational open question**: #18 billing/quota ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)), #16 cross-Camp consistency ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)), #19 migration/onboarding ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)), #17 local-dev fidelity ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)), and #20 multi-Yard federation — clarified + the **Junction** designed, v1 single-Yard ([ADR-0043](../design/adr/07-portability-extensibility.md#adr-0043)). **The gap-analysis + open-questions backlog is fully remediated in design** (ADRs 0029–0043).
7. ✅ **Post-growth re-survey (Plans 39–44 / ADRs 0044–0058):** no new material competitive gaps; **G9 crypto closed** (`hobo:crypto`). The suite is feature-complete for a v1 — what remains are explicit iteration hooks, not gaps.

> New gaps from this analysis are filed as open questions **#21–23** in [09](../design/generated-stack.md#historical-open-question-ledger); the rest reinforce the existing #3/#10/#12/#15–18 priorities.

## 6. Full re-evaluation (refreshed 2026-08-04 — every capture vs HoBo)

> **This is the current-state pass.** §§1–5 are the historical reasoning trail (markers frozen at their dates). This section re-scores every capture against the design suite *as it stands on `main` today* — every capture's feature surface + `hobo-mapping` was re-read and cross-checked against the live gap register ([`GAPS.md`](../../GAPS.md), review closed 2026-07-02: 38 findings, all with documented remediations) and the [ADR index](../design/adr/index.md). The headline is unchanged — **no competitor spans HoBo's intersection bet** (agnostic IfC + durable event-sourced runtime + agents/generation pipeline, self-hostable) — but this pass is deliberately **honest about what is designed-on-paper vs proven**, and separates the handful of genuine open **design iteration hooks** from the larger cluster of **execution-bar** pressures. NetScaler was folded in by the original 2026-07-03 pass (§6.2). **The 2026-08-04 refresh extends the §6.1 table from the original 14 rows to all 35 captures** (a 36th — [Alchemy](alchemy.md), §3h — was rowed 2026-08-17) (the mainstream-PaaS cohort and the cleared future-competitor backlog from §3f now get first-class rows) **and re-checks every residual against the shipped remediation wave** — closures are moved to the §6.3 closed list with in-repo anchors.

Legend: ✅ parity · ➕ HoBo goes further · ◐ designed-but-shallow/deferred · ✗ gap · 🔜 planned/tracked · ↔ different substrate, same idea · 🔌 composes *as a HoBo provider*, not a rival.

### 6.1 Current comparison matrix — all 36 captures

| Competitor | Category | What it leads on | HoBo's answer (status) | Net |
|---|---|---|---|---|
| **[Nitric](nitric.md)** | head-on (IfC) | Shipping multi-cloud IfC + auto least-priv IAM from `.allow()`, gRPC "Membrane" polyglot | triple-effect `.allow()` (IAM+wasm-cap+token) ➕, wRPC/WIT membrane ➕, dev/prod auth parity ➕ | HoBo superset in design; Nitric's edge is **shipping-maturity** of its provider fleet |
| **[Encore](encore.md)** | head-on (IfC) | Production IfC for TS/Go + best-in-class local loop (`encore run` real Postgres/Pub-Sub + `:9400`) | any-cloud + pluggable IaC ➕, language-neutral wasm ➕, Matching/Dispatcher ➕; local fidelity matrix ✅ ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) *unproven* | Validates the authoring model; **local-fidelity proof** is the live execution bar |
| **[Lakebed](lakebed.md)** | head-on (AI meta-cloud) | Zero-config single-directory instant-on (`new`→`dev`→anonymous `deploy`), `llms.txt` contracts | anonymous deploy ✅ ([Plan 7](../design/developer-experience.md#plan-07)), adopt-in-place `hobo import lakebed` ➕ ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | Named rival; **holistic onboarding simplicity** is an open DX bar, not a closed gap |
| **[Nomad](nomad.md)** | head-on (scheduler, displaced) | Battle-tested heterogeneous scheduling; constraint/affinity/spread; raw-exec/Java/QEMU; Consul/Vault depth | scheduler pillar **displaced** ([ADR-0106](../design/adr/01-architecture-core.md#adr-0106)) → wasmCloud + Matching + Dispatcher; in-Camp scheduling ✅ ([ADR-0108](../design/adr/01-architecture-core.md#adr-0108)); placement-criteria vocabulary **shipped** — property selectors, affinity/anti-affinity, spread, `pickN` (`packages/cloud/src/planner/placement.ts`) ✅ | Placement expressiveness **closed 2026-08-04**; **legacy-workload drivers + system jobs remain 🔜** (design iteration hook) |
| **[Humanitec](humanitec.md)** | adjacent (orchestrator) | Mature Score + Resource Definitions + specificity **Matching**; RBAC/approvals/drift; air-gap; Agent tunnel | Matching ✅➕ + auditable `match.Decided` ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)); ABAC/air-gap/Relay ✅ | Design parity+; the real risk is **maturity/proof** — "can't win on AI-native alone" |
| **[Convex](convex.md)** | adjacent (reactive BaaS) | Deterministic reactive query reactor w/ simultaneous consistent-snapshot push; E2E TS codegen | reactive queries ✅ ([Plan 32](../design/data-plane.md#plan-32)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) via event-log reactor ↔➕; `_generated/` ✅ ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)) | **Composes as a provider**; the once-blind-spot (reactivity) is now designed |
| **[InsForge](insforge.md)** | adjacent (agent BaaS) | Concrete agent-ops loop: read state → branch → edit migration → apply → diagnose → repair via MCP/CLI | `@hobo/mcp` + agents-as-principals + projections ✅ ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | No arch gap; **agent-legibility ergonomics is a gap-pressure execution bar** |
| **[Antimetal](antimetal.md)** | adjacent (AI SRE) | 90+ connectors + normalized cross-tool world model; evidence-backed RCA/fix artifact; MCP polish | Operator Agents/Crew + SRE incidents + event projections ✅ ([Plan 40](../design/operators-sre.md#plan-40)) | No arch gap; **MCP polish + integration breadth** is execution pressure |
| **[FinOps tooling](finops-tooling.md)** | adjacent (cost) | Kubecost allocation · Infracost PR gates · Vantage multi-cloud · Cast.ai autoscaling/rightsizing | metering/showback/quota/cost-routing in-plane ✅ ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | Differentiator (cost *inside* the control plane); **Cast.ai-level autoscaling is ◐ partial** |
| **[shoo.dev](shoo.md)** | adjacent (end-user auth) | 2-line zero-config Google sign-in; ES256/JWKS; mandatory PKCE; pairwise-sub privacy | federate+verify `hobo:auth` ✅➕ ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)) | **Composes, doesn't compete** — corroborates HoBo's identity choices |
| **[NetScaler](netscaler.md)** | adjacent (ADC appliance) | Deep L4-L7 ADC data plane (LB/GSLB/SSL/WAF/gateway); StyleBooks/Next-Gen API; `nsconf2iac` | 🔌 candidate `gateway`/`domain` provider ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)); `nsconf2iac` < `hobo import` ➕ ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | **Provider *for* HoBo, not a rival**; only `nsconf2iac` vs `hobo import` is head-to-head |
| **[Aspire](aspire.md)** | component/analog (inner loop) | Code-first composition + one-command local parity + OTel dashboard + manifest IR | Bindle + IfC ✅ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)), manifest IR ✅, dashboard ✅ ([Plan 7](../design/developer-experience.md#plan-07)) | Inspired HoBo's wiring layer; **health-gated ordering (GAP-027) is ◐ open** |
| **[Dapr](dapr.md)** | component/analog (runtime) | 12 portable building blocks + pluggable components at the sidecar; workflows/actors/crypto | ports/capability-provider spine ✅ near-1:1 ([Plan 20](../design/wasm-runtime-wit.md#plan-20)); `hobo:crypto` ✅ | Strongest **validation** of the ports spine; **unified Bindings + general lock are 🔜** |
| **[wasm hosts](wasm-hosts.md)** | component/analog (substrate) | Wasmtime · Spin/SpinKube · wasmCloud — WIT/WASI portability, deny-by-default, ~1ms cold start | `component-host` adapter slots ✅ ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); cross-host links ✅ | Thesis **holds**; only two impl-pinning refinements (runwasi shim, wRPC/NATS transport) |
| **[Heroku](heroku.md)** | head-on (mainstream PaaS) | 15+ years of `git push` DX (invented the vocabulary); 200+ add-on marketplace; Heroku Flow CI/CD; shipping AI PaaS (Managed Inference, MCP hosting) | Camps + `component-host` ➕ ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); event-sourced releases/rollback ➕ ([Plan 11](../design/data-plane.md#plan-11)); add-ons ↔ catalog ports + `.allow()` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); marketplace monetization ✗ by design ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | Design superset; Heroku's **operational maturity + buildpack/add-on ecosystem** is the honest shipping lead |
| **[Render](render.md)** | head-on (mainstream PaaS) | Managed-ops polish (HA Postgres/PITR, autoscaler, single-pane ops); `render.yaml` Blueprints; Workflows beta | ports + manifest IR ➕ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); durable event-sourced workflows ➕ ([Plan 11](../design/data-plane.md#plan-11)); managed-DB *operations* provider-delegated ◐ | Deeper model on paper; **Render ships the managed runtime** — maturity is the whole delta |
| **[Railway](railway.md)** | head-on (mainstream PaaS) | Zero-config git-push DX (Railpack); editable multiplayer Canvas; template marketplace; Railway Metal | IfC + topology projection ✅ (`hobo inspect graph` shipped, [Plan 49](../design/developer-experience.md#plan-49)); Resource Packs/Registry ◐ ([ADR-0062](../design/adr/07-portability-extensibility.md#adr-0062)); marketplace kickback ✗ by design ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | Canvas/template polish is shipping DX HoBo hasn't proven; no architecture gap |
| **[Fly.io](flyio.md)** | head-on (edge PaaS) | Global Anycast edge + Firecracker microVMs at scale; Machines API; LiteFS edge SQLite | `vm`/`microVm` adapters ◐ ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); Junction federation + `domain` ingress 🔜 ([ADR-0043](../design/adr/07-portability-extensibility.md#adr-0043)/[ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)); Tigris → `bucket` port ✅ | **Fly is ahead on real global-edge runtime**; HoBo's answer is designed, unshipped |
| **[Vercel](vercel.md)** | head-on (frontend cloud) | Frontend/edge DX + ISR; Fluid compute; shipping durable **Workflow SDK** (`"use workflow"`, Worlds); v0/AI SDK/AI Gateway | durable event-sourced workflows ➕ designed ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)); Worlds ↔ WIT ports ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)); `web()` ◐ (HoBo is not a frontend cloud) | Worlds **validates the port thesis**; Vercel ships what HoBo designs — no first-party edge network, by substrate choice |
| **[Netlify](netlify.md)** | head-on (frontend PaaS) | Polished git→build→deploy + Deploy Previews; Edge Functions; Blobs + Netlify DB (Neon) | `web()` + `hobo:sql` with a Neon-class adapter ✅ ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)); previews = Camps ◐ ([Plan 25](../design/platform-engineering.md#plan-25)); app-facing `cache` port ✅ ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)) | No architecture gap; **Jamstack build-ecosystem breadth** is the shipping lead |
| **[Modal](modal.md)** | head-on (AI compute) | Serverless GPU (T4→B200, per-second); sub-second cold starts + memory snapshots; gVisor agent Sandboxes | GPU tiers via Matching/Dispatcher ◐/🔜 ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)); sandbox lanes + wasm isolation ↔ ([ADR-0076](../design/adr/02-identity-security.md#adr-0076)); state/queue/secret ports ✅ | **Modal is clearly ahead on GPU serverless + cold-start performance** — the strongest single shipped lead in the set |
| **[AWS Amplify](aws-amplify.md)** | head-on (IfC, AWS-only) | Shipping IfC-in-TS (`defineBackend`/`defineData`/`defineAuth`) on CDK; per-model `allow.*` authorization | same thesis cloud-agnostic + language-neutral ➕ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[ADR-0069](../design/adr/01-architecture-core.md#adr-0069)); triple-effect `.allow()` ➕; Cognito-depth user directory ◐ ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)) | Strong external **validation** of `.allow()`/IfC; bounded to AWS — breadth is HoBo's delta |
| **[SST](sst.md)** | head-on (IfC framework) | v3 "Ion" on Pulumi+Terraform (150+ providers); typed Linking; Live local dev; Console | pluggable IaC behind a port ➕ ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)); `.allow()` ✅➕ + `_generated/` ✅ ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)); Live-fidelity bar 🔜 ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) | Validates the Pulumi/TF substrate + linking DX; **multi-provider ≠ multi-cloud-portable** is HoBo's delta (§3g) |
| **[Alchemy](alchemy.md)** *(rowed 2026-08-17)* | head-on (IfC engine) | Engine-less TS-native IaC, shipping: direct-API `reconcile` providers + `--adopt`, bindings-are-the-SDK, workerd local dev, real-cloud deploy→assert→destroy tests, credentials-as-code CI, OTel-by-default, **LLM-authored providers** | IaC behind a port ➕ — 🔌 **candidate `iac-alchemy` engine adapter** ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)); `.allow()` ✅➕ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); generation pipeline adds the verify/certify half ➕ ([Plan 23](../design/generated-stack.md#plan-23)); governance/portability planes unanswered ➕ | Validates **un-bundle-the-engine + AI-authored providers**; alpha, TS-only, Effect-welded, two-cloud — an engine, not a control plane (§3h) |
| **[Winglang](winglang.md)** | component/analog (authoring; cautionary) | Real shipped language + simulator (preflight/inflight split, capture-based IAM); Wing Cloud shut down 2025 | same authoring/runtime split **without a new language** ✅/➕ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)+[Plan 20](../design/wasm-runtime-wit.md#plan-20)); pluggable IaC vs fixed TF/CDK synth ➕ ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | Cautionary tale — reinforces the OSS + self-host = hosted stance; no gap |
| **[Wasp](wasp.md)** | component/analog (full-stack framework) | Declarative `.wasp` spec + Open-SaaS starter kit; typed RPC for free | Bindle IfC ➕ ([Plan 25](../design/platform-engineering.md#plan-25)); `_generated/` client ✅ ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)); App-Kit/Resource-Pack packaging path 🔜 ([ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144)) | The **App-Kit borrow**; a Wasp app deploys onto HoBo as a service — adoption path, not rival |
| **[Qovery](qovery.md)** | adjacent (BYOC IDP) | Mature BYOC into your AWS/GCP/Azure/Scaleway account; OSS Rust engine; environment-as-unit + previews | Camps + pluggable IaC ✅➕ ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)); IfC vs console/config authoring ➕ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | Validates the "your cloud, your data" stance; Qovery's at-scale proof is the lead |
| **[Northflank](northflank.md)** | adjacent (container PaaS) | Full-stack PaaS at scale: services/jobs/addons, BYOC (incl. GPU clouds), pipelines/GitOps | wasm-default + OCI fallback ➕ ([Plan 20](../design/wasm-runtime-wit.md#plan-20)); `cache` vs durable-kv split ✅➕ ([ADR-0118](../design/adr/03-data-plane.md#adr-0118)); turnkey DBaaS backup UI ◐ ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) | Mature ops polish is the lead; the K8s-native floor is exactly what HoBo removes |
| **[Backstage](backstage.md)** | complementary (portal) | 140+-plugin portal ecosystem; Catalog/Scaffolder/TechDocs; CNCF maturity | **derived** resource graph (byproduct of provisioning) + Registry ◐/➕ ([ADR-0062](../design/adr/07-portability-extensibility.md#adr-0062)/[Plan 49](../design/developer-experience.md#plan-49)); governance over real deploys, not portal actions ➕ ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | **Complementary, not head-on** — a Backstage plugin could surface a HoBo Yard; portal UX depth stays Backstage's |
| **[Crossplane](crossplane.md)** | component/borrow (IaC substrate) | Graduated CNCF control plane; reconciliation/controller pattern; provider ecosystem; Compositions/XRDs | reconcile model **borrowed** ✅ ([Plan 4](../design/control-plane.md#plan-04)); XRD/Composition ↔ Resource Definitions + **auditable** Matching ➕ ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)); first-party `IacProvider` adapter 🔌 ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | 🔌 **HoBo drives Crossplane**; the `match.Decided` audit record is the delta over selector-based composition |
| **[Radius](radius.md)** | component/borrow (app model) | Recipes + Resource Types + live app-graph API/Dashboard + connections; shipping CNCF platform | Recipes ↔ Resource Definitions/Matching ➕ ([Plan 25](../design/platform-engineering.md#plan-25)); connections ↔ `.allow()` ➕ ([Plan 21](../design/authoring-resources-wiring.md#plan-21)); app-graph projection + RealizationResult contract **shipped** | The key borrow-source; Radius's shipped Dashboard vs HoBo's fresh projections — gap narrowing, not open |
| **[wasmCloud](wasmcloud.md)** | adopted substrate | Shipping CNCF lattice/wRPC/capability-provider runtime | **HoBo's default `component-host`** ✅ ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); wRPC membrane ✅ ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) | 🔌 dependency, not rival — HoBo adds provisioning + control plane + AI-native above it |
| **[Spin / Fermyon](spin-fermyon.md)** | adopted substrate | Spin DX + SpinKube K8s host + Fermyon Serverless AI; ms-class cold starts | SpinKube = per-Camp host adapter ✅ ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); triggers → ports near-1:1 ✅ ([Plan 20](../design/wasm-runtime-wit.md#plan-20)); model-inference port depth ◐/🔜 | 🔌 adapter option; Serverless-AI-grade inference-port depth is the small residual |
| **[Supabase](supabase.md)** | adjacent (BaaS + provider) | Postgres depth + RLS; shipping Realtime Broadcast/**Presence**; pgvector; huge OSS adoption | `hobo:auth` federates — Supabase Auth is a **named adapter** ✅ ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)); RLS ↔ app-tenant model ➕ ([Plan 50](../design/security-networking.md#plan-50)); presence designed-not-shipped 🔜 ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)) | **Composes as a provider**; shipped-collaboration (Presence) remains the honest 🔜 |
| **[ServerKit](serverkit.md)** | adjacent (self-host panel) | MIT self-hosted panel: full mail stack, WAF/security suite, Go **agent fleet** (pairing, WireGuard tunnels, drift-detecting templates) | Registry/marketplace + GitOps + preview Camps at parity ([Plan 25](../design/platform-engineering.md#plan-25)/[Plan 40](../design/operators-sre.md#plan-40)); host/OS management below HoBo's app-topology line ✗ by design | Node-attach/**Relay reference** pressure for self-host DX; the mail stack stays out of scope |
| **[Octopus Deploy](octopus-deploy.md)** | lesson source (delivery) | Environments/lifecycles/tenants/runbooks; manual-intervention gates; human-first release orchestration | Deployment Sets + policy-gated promotion ✅➕ ([Plan 25](../design/platform-engineering.md#plan-25)); `require-approval` + A2H ✅➕ ([ADR-0094](../design/adr/02-identity-security.md#adr-0094)); staged rollout stages/groups/approvals/resume **shipped** in `@hobo/identity`; Channels 🔜 | Delivery-domain lessons absorbed (staged rollouts now shipped); runbook human-first maturity is the lead |

**Reading:** four columns of the moat still stand uncontested per-competitor — multi-cloud + pluggable IaC (no head-on rival has it), a language-neutral wasm runtime, event-sourced governance, and agents-as-principals + the generation pipeline. What the honest pass surfaces is that **the remaining deltas are concentrated, not broad**: a short list of design iteration hooks (§6.3) and a recurring execution-bar theme (§6.4).

### 6.2 Per-competitor verdicts (current)

**Head-on set** — the products HoBo actually competes with:
- **Nitric** — closest on the *paradigm* (IfC + `.allow()` + multi-cloud). HoBo's design is a strict superset (wasm/WIT polyglot, wRPC membrane, actors/event-sourcing, AI-generated providers *and* implementations, dev/prod auth parity vs Nitric's local OIDC-enforcement gap). The honest caveat: Nitric's provider fleet is **shipping and human-hardened**; HoBo's breadth claims are design-stage. Delta = proof, not coverage.
- **Encore** — closest on the *product* (IfC → real managed services with an elite local loop). HoBo's breadth (any-cloud, pluggable IaC, language-neutral wasm, Resource Definitions/Matching + Dispatcher, broad data-paradigm catalog, event-sourced governance) is the delta; Encore's `encore run` real-infra + `:9400` dashboard is the **fidelity bar `hobo dev` must prove** (designed as a fidelity matrix, [ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042); unproven).
- **Lakebed** — the named AI-native-meta-cloud rival, but a *closed single-runtime PaaS*; HoBo is a cloud-agnostic control plane that self-hosts and imports existing estates. HoBo borrows its `llms.txt`/anonymous-deploy ethos. **Open DX bar:** one-directory zero-config simplicity.
- **Nomad** — the scheduler pillar is a **deliberate displacement** ([ADR-0106](../design/adr/01-architecture-core.md#adr-0106)): wasmCloud self-host + Matching + Dispatcher subsume it, and Nomad becomes an accepted-future deploy target. **Placement expressiveness is closed since 2026-07-03** — `packages/cloud` ships a HoBo-native placement-criteria vocabulary (property selectors, affinity/anti-affinity, spread, `pickN`). What stays thin is **system jobs** and **legacy-workload drivers** (raw-exec/Java/QEMU host adapters) — see §6.3.

**Mainstream PaaS cohort (rows added 2026-08-04)** — the "just deploy my app" set (§3f):
- **Heroku** — HoBo's design is a superset, but Heroku's 15-year operational record + 200+-add-on ecosystem is the maturity bar; monetized marketplace cells are ✗ by design ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).
- **Render** — the model delta (event-sourced workflows, per-env realization) is HoBo's; the managed-runtime/HA-data operations delta is entirely Render's.
- **Railway** — its editable Canvas and one-click templates are real shipping DX leads; HoBo's topology projection now ships (`hobo inspect graph`), the polish does not.
- **Fly.io** — ahead on real global-edge runtime (Anycast + Firecracker + LiteFS); HoBo's Junction/domain answer is designed, unshipped.
- **Vercel** — its Workflow SDK "Worlds" swappable-adapter design independently validates HoBo's port thesis; HoBo does not compete for the frontend-cloud/edge-network surface.
- **Netlify** — no architecture gap; Jamstack build-ecosystem breadth and Deploy-Preview polish are the leads.
- **Modal** — the strongest single shipped lead in the set: serverless GPU + cold-start performance + gVisor Sandboxes; HoBo's GPU-placement story is a design hook, honestly ◐/🔜.
- **AWS Amplify** — the closest shipping analog to `.allow()`-style IfC-in-TS; bounded to AWS, which is exactly HoBo's breadth delta.

**Backlog cohort (rows added 2026-08-04)** — cleared future-competitor backlog (§3f/§3g):
- **SST** — validates the Pulumi/TF-under-IfC substrate and typed-linking DX (§3g); multi-provider ≠ multi-cloud-portable is the honest framing of its "150+ providers".
- **Alchemy** *(added 2026-08-17)* — the closest shipped artifact to HoBo's authoring/provisioning core: engine-less TS-native IaC (direct-API reconcile providers, no Pulumi/TF), bindings-are-the-SDK, workerd-fidelity local dev, real-cloud testing, credentials-as-code CI, and LLM-authored providers live today. It validates un-bundle-the-engine **and** AI-authored providers, but is alpha, TS-only, Effect-welded, and two-cloud, with no portability/governance/audit/agent planes. Compose-don't-compete: a 🔌 **candidate `iac-alchemy` engine adapter** and a generation-pipeline codegen target (§3h, [alchemy.md](alchemy.md)).
- **Winglang** — same authoring/runtime split without a new language; Wing Cloud's 2025 shutdown reinforces the OSS + self-host = hosted stance.
- **Wasp** — the App-Kit borrow ([ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144)); an existing Wasp app adopts onto HoBo as a service, no dual authoring.
- **Qovery / Northflank** — mature BYOC IDP/PaaS products that validate the Camps + pluggable-IaC stance; their at-scale operational proof is the lead, their K8s floor the difference.
- **Backstage** — complementary portal, not a rival; HoBo derives its graph from provisioning where Backstage hand-authors YAML — and Backstage's plugin ecosystem is far larger today.
- **Crossplane / Radius** — borrow-sources: Crossplane's reconcile pattern and Radius's Recipes/connections map onto Resource Definitions/Matching + `.allow()`; HoBo adds the auditable `match.Decided` record, and the Radius-inspired RealizationResult + app-graph deliverables shipped in the remediation wave.
- **wasmCloud / Spin-Fermyon** — adopted substrate: wasmCloud is HoBo's default `component-host`, SpinKube an adapter option ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)); only inference-port depth trails Fermyon's Serverless AI.
- **Supabase** — composes as a provider (Supabase Auth is a named `hobo:auth` adapter); shipped Realtime Presence vs HoBo's designed disposition ([ADR-0119](../design/adr/03-data-plane.md#adr-0119)) is the honest 🔜.
- **ServerKit** — self-host/node-attach reference pressure (agent fleet, WireGuard pairing, drift-detecting templates); host/OS management stays below HoBo's line by design.
- **Octopus Deploy** — delivery-domain lesson source; its staged-rollout/approval lessons are now shipped machinery in `@hobo/identity`; Channels have no direct analog yet (🔜).

**Adjacent set** — pressure on one surface, or composes rather than competes:
- **Humanitec** proves the orchestrator+governance abstraction HoBo adopts; the standing risk is *maturity*, not design coverage. **Convex** and **shoo.dev** are things HoBo *realizes as providers*; both corroborate HoBo choices (reactivity now designed; identity choices shared). **InsForge** and **Antimetal** set concrete *agent-operability* and *SRE-agent* execution bars — no new plane, but hardened acceptance criteria for CLI/MCP/projection work. **FinOps tooling** validates cost-in-the-control-plane as a differentiator; Cast.ai-level automation is the partial edge. **NetScaler** is a candidate `gateway`/`domain` provider, not a rival — its `nsconf2iac` config→IaC converter is the one head-to-head, and HoBo's stateful `hobo import` (adopt-in-place, drift detection, incremental strangler-fig) is strictly stronger than one-shot codegen.

**Component/analog set** — layers HoBo builds *on* or *above*:
- **Aspire** directly inspired HoBo's wiring/manifest layer (high parity), but exposes **GAP-027** (§6.3). **Dapr** is the strongest external validation of HoBo's ports/capability-provider spine (12 building blocks ≈ 1:1), and flags two 🔜 residuals. **wasm hosts** confirm the `component-host` thesis with only impl-pinning refinements.

### 6.3 Residual **design** iteration hooks (genuine, tracked — not yet landed)

These are the items where a competitor does something HoBo has *not fully designed* yet (distinct from "designed but unproven"). All are tracked; none is fatal; each is scoped.

**Closed since 2026-07-03** (shipped by the remediation wave; verified in-repo, not just designed):

- ✅ **Nomad-class placement expressiveness** (was the first half of hook 2). `packages/cloud` now ships a HoBo-native placement-criteria vocabulary — property selectors (cost/capacity/region/latency/custom), affinity/anti-affinity between resource classes, spread across regions/yards, `pickN` cardinality — evaluated by the planner (`packages/cloud/src/planner/placement.ts`).
- ✅ **Residency/jurisdiction loop** (was an ADR-0146 wiring residual). [ADR-0146](../design/adr/02-identity-security.md#adr-0146)'s fail-closed `evaluateResidency` is now wired end-to-end: `hobo verify` threads `Tenant.residency` + plan region and emits `gate:"residency"` reasons (`packages/hobo/src/verify-command.ts`), and the broker maps them to a plane distinct from policy (`packages/broker/src/planes.ts`).
- ✅ **Staged rollout strategies** (the Octopus/Humanitec staged-delivery pressure). `@hobo/identity`'s `RolloutStage`/`RolloutPolicy`/`RolloutState` + `OpenDeliveryEngine` now ship ordered stages with parallel groups, `concurrency`, `maxFailures`, approval gates, and deterministic `resumeFrom` (`packages/identity/src/harness-delivery.ts`); percent-ramps remain the degenerate case.

**Still open:**

1. **Health/readiness-gated dependency ordering — `GAP-027`** (from **Aspire** `WaitFor`/`WaitForStart`/`WaitForCompletion`). HoBo's deploy DAG gates dependents on `resource.Provisioned` (IaC apply succeeded) only — **not** on *running + healthy* or a one-shot exiting 0. Health checks exist inside rollout sagas ([Plan 5](../design/reliability-observability-cost.md#plan-05)) but not as a cross-resource dependency edge. Remediation is *documented* ([REM-035](../../GAPS.md#rem-035-for-gap-027)/[HOBO-703](https://linear.app/quickdeploy-ai/issue/HOBO-703)) but the design has **not landed** — it remains the [Plan 4 iteration hook](../design/control-plane.md#health-gated-dependency-ordering-iteration-hook), and `aspire.md` correctly marks the row ◐.
2. **Nomad system jobs + legacy drivers** (from **Nomad** — the surviving half of the old hook 2). In-Camp scheduling is designed ([ADR-0108](../design/adr/01-architecture-core.md#adr-0108)) and the constraint vocabulary shipped (above), but **system jobs** are 🔜 and **raw-exec/Java/QEMU host adapters** (↔) for brownfield/legacy workloads are not yet designed. The scheduler *pillar* is displaced ([ADR-0106](../design/adr/01-architecture-core.md#adr-0106)); this residual is about **reach**, and HoBo must preserve brownfield reach via OCI/VM/host adapters.
3. **Unified `bindings` connector port** (from **Dapr** Bindings). HoBo has partial coverage via `hobo:blob-events` + `hobo:scheduler` + messaging/handler triggers ([ADR-0072](../design/adr/01-architecture-core.md#adr-0072)), but **no first-class catch-all input/output connector port** — 🔜.
4. **General cross-aggregate `lock()`** (from **Dapr** Distributed lock). The common "serialize writes to one entity" case is subsumed by the **aggregate = single-writer actor lease** ([ADR-0053](../design/adr/03-data-plane.md#adr-0053)); what's missing is a standalone lock for **cross-aggregate / cross-resource** critical sections — 🔜, low priority.
5. **Aspire-grade local depth** (from **Aspire**). Two MED items in the register: local-**dashboard depth** and **external/adopted-resource** dev semantics remain under-specified. The whole-graph **in-process test harness** half of this hook is now **designed** — [ADR-0159](../design/adr/07-portability-extensibility.md#adr-0159)'s `@hobo/testing` in-process lane commits the harness contract (GAP-026), leaving implementation as the residual (◐ → design ✅, shipping 🔜).
6. **GPU-serverless placement depth** (from **Modal**, new with the 2026-08-04 rows). GPU node tiers are reachable in principle via Resource Definitions + cost-routed Matching ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)), but a GPU-class placement/pricing vocabulary and a sandboxed agent-compute profile at Modal's bar are not designed — ◐/🔜.

### 6.4 Recurring **execution-bar** pressures (design has an answer; the bar is proof/polish)

Not architecture gaps — the design covers them — but the captures set concrete bars HoBo must *hit*, and they cluster around the same theme: **agent-operability and first-run fidelity**.

- **Agent-ops legibility loop** (InsForge): every control-plane surface must let an agent fetch state → branch → edit migration/config → apply → diagnose → read advisor findings → repair, no dashboard clicks.
- **High-fidelity local dev, proven** (Encore): `hobo dev`'s simulate/mock/Camp-only fidelity matrix + `hobo verify` must demonstrably match `encore run`'s real-Postgres/real-Pub-Sub/`:9400` bar.
- **MCP polish + normalized incident/RCA/artifact resources** (Antimetal): carry HoBo's stronger contract/type/test/policy gates *into* the fix artifact (Antimetal's generated fixes notably don't run tests/builds).
- **Zero-config instant-on** (Lakebed): anonymous deploy exists; the holistic one-directory onboarding *feel* is the target.
- **FinX advisory depth** (FinOps tooling): forecasting/anomaly signals and **non-K8s (wasm) usage→price** allocation fidelity ([ADR-0115](../design/adr/02-identity-security.md#adr-0115)/[ADR-0117](../design/adr/03-data-plane.md#adr-0117) designed; execution pending); Cast.ai-level autoscaling is policy-gated-degradation today, not full rightsizing.
- **Governance maturity** (Humanitec): the design matches; the market proof does not exist yet — HoBo cannot win on "AI-native" alone.

### 6.5 Deliberate non-goals (re-confirmed, not gaps)

- **An ADC/L4-L7 data plane** (NetScaler) — HoBo orchestrates such appliances behind the `gateway`/`domain` port; it does not build one.
- **App-business functions** — billing/monetization/payments/analytics as a *product* stay outside the core ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); they remain provider/Resource-Pack opportunities (InsForge/Convex surface these).
- **Enterprise commitment/RI/Savings-Plan purchasing workflows** (Cast.ai/Vantage) — `CreditLedgerView` handles credit/free-tier rotation, not procurement.

### 6.6 Bottom line (refreshed 2026-08-04)

The intersection bet is **still uncontested across all 36 captures** — no single competitor spans agnostic-IfC + durable event-sourced runtime + agents/generation-pipeline, self-hostable — and every competitor strength maps to a Plan/ADR (✅/➕) or composes as a provider (🔌). The correction the 2026-07-03 pass made to the older "**everything is closed / feature-complete**" framing — *honesty about stage* — holds; what the 2026-08-04 refresh adds is that the remediation wave **shipped three of the residuals** (placement-criteria vocabulary, the ADR-0146 residency loop, staged rollout strategies — §6.3 closed list), and the 21 newly-rowed captures surface **no new architecture gap**: their leads are shipping maturity (Heroku/Render/Railway ops polish, Fly's edge runtime, Modal's GPU serverless, Supabase's shipped Presence, Backstage's plugin ecosystem) or they compose as substrate/providers (wasmCloud, SpinKube, Crossplane, Radius, Supabase). The open set is now: **GAP-027 health-gating**, Nomad **system jobs/legacy drivers**, Dapr **bindings/lock**, **Aspire-grade local depth**, and **GPU-serverless placement depth** (§6.3), plus the standing execution-bar theme (§6.4 — agent-operability + first-run fidelity). Priority order to keep the moat credible: **(1)** land GAP-027 health-gated ordering; **(2)** prove `hobo dev` local fidelity + the agent-ops loop (Encore/InsForge bars); **(3)** design the legacy-driver/system-job residuals if brownfield demand appears; **(4)** the Dapr bindings/lock ports as a small additive tranche; **(5)** a GPU-placement vocabulary if AI-compute demand warrants chasing Modal. None is fatal; all are addressable.

## 7. Corpus-wide adversarial reconciliation (2026-08-20 — all 86 captures)

> **This supersedes §6 as the current-state pass.** The corpus grew from 36 captures to **86** across
> the 2026-08 research programme, every one now written to the
> [HoBo Competitive Research Contract](metadata-contract.md) (`contract: v1`). §6 remains accurate
> for the captures it scored; this section reconciles the *whole* corpus and is deliberately
> adversarial — it looks for what the previous passes' framing made hard to see.
>
> **The previous bottom line does not survive intact.** §6.6 concluded that the open set was five
> named residuals plus an execution-bar theme. Fifty new captures later, that is no longer the
> shape of the problem. Three *architecture-level* gaps surfaced that no earlier pass named, and the
> honest reading is that HoBo's differentiation is increasingly **designed rather than shipped**
> while the products it is measured against ship.

### 7.1 New architecture-level gaps

These are not execution-bar items. Each is a thing HoBo's design does not currently do, surfaced by
a capture that does it.

| # | Gap | Surfaced by | Why it is architectural |
|---|---|---|---|
| **N1** ✅ | **Drift is not a first-class computed fact.** *(Closed 2026-08-20 — `computeDrift` in `@hobo/cloud`, [ADR-0163](../design/adr/03-data-plane.md#adr-0163). Derived, not stored; classified by typed lifecycle rather than field diff.)* HoBo can *derive* divergence between recorded intent and materialized reality from its event log. Nothing derives it, names it, or shows it to anyone unprompted. | [Argo CD](argo-cd.md) (`OutOfSync` + per-resource diff), [Flux CD](flux-cd.md), [Crossplane](crossplane.md) | Reconciliation is table stakes in this category; *showing a human the difference* is what the category's users actually buy. HoBo has the harder half (an authoritative log) and not the visible half. |
| **N2** ✅ | **`match.Decided` is a one-shot decision that nothing revisits.** *(Closed 2026-08-20 — `evaluateReplacement` in `@hobo/cloud`, [ADR-0164](../design/adr/01-architecture-core.md#adr-0164). Verdict separate from re-match; price still pending N5.)* Prices, capacity, policy and residency rules all move; the recorded decision does not. | [CAST AI](cast-ai.md) (continuous re-optimization), [Rancher Fleet](rancher-fleet.md) | A placement engine whose decisions are never re-evaluated is a configuration tool with an audit trail. The fix — re-evaluation emitting a new `match.Decided` — is additive but is a genuine design extension, not polish. |
| **N3** ✅ | **Extension lifecycle is unsolved.** *(Closed 2026-08-20 — `comparePackVersions` and `planPackUpgrade` in `@hobo/pack-framework`, [ADR-0165](../design/adr/07-portability-extensibility.md#adr-0165). Versions are orderable; majors cross only by name; dropped profile claims and unverified targets block rather than skip. Residuals: no pack-to-pack dependency graph — packs declare profiles, not packs — and no channel/subscription model, so nothing schedules the check.)* Resource Packs have no install/upgrade/dependency-resolution story worth the name. | [OpenShift](openshift.md) (OLM), [Kratix](kratix.md) (Promise updates), [Backstage](backstage.md) (the plugin treadmill) | Every extensible platform in this corpus either solved this deliberately or is visibly suffering. It is the difference between an extension model and a distribution problem the user inherits. |

Two further items sit just below the line — real, but closer to unclaimed opportunity than to
missing mechanism:

- **N4** ✅ — **the estimate-versus-actual loop is unclosed everywhere**, and HoBo holds both sides in
  one event log ([ADR-0135](../design/adr/03-data-plane-sqlite-default.md)). [Infracost](infracost.md)
  never sees actuals; [Kubecost](kubecost.md) and [Vantage](vantage.md) never see estimates. This is
  the clearest *novel* feature the whole FinOps cohort leaves on the table. *(Closed 2026-08-20 —
  `reconcileCost` in `@hobo/cloud`, [ADR-0166](../design/adr/03-data-plane.md#adr-0166). Integer
  minor units; unestimated cost reported rather than dropped; unrealized estimates excluded from the
  variance; a short observed window refused rather than reported as a saving. Residual, and it is a
  real one: nothing produces the actuals side yet — `meter.UsageRecorded` has no producer outside
  tests and the connectivity billing aggregator is not wired to deployments — so the loop is closed
  as a computation before it is closed as a pipeline.)*
- **N5** ✅ — **multi-provider price data is an unresourced dependency.** Cost-aware placement
  ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) needs accurate prices, which is
  precisely the asset [Infracost](infracost.md) and [Vantage](vantage.md) built businesses around.
  Treating it as free was a planning error. *(Closed 2026-08-20 in two parts. **Scoping:**
  `classifyPriceQuality` / `assessCostObjective`,
  [ADR-0167](../design/adr/01-architecture-core.md#adr-0167) — an unpriced offering is no longer
  indistinguishable from a free one, and a cost-optimality claim is withheld when the candidate set
  cannot support it. This fixed an active fault: every provider default is `marginalPrice: "0"`, so
  under `min-cost` a provider that declared nothing outranked every provider that declared a real
  price. **Resourcing:** `buildPriceBook` / `lookupPrice` / `priceBookCoverage`,
  [ADR-0168](../design/adr/01-architecture-core.md#adr-0168) — consume the vendors' own published,
  unauthenticated feeds (AWS Price List Bulk, Azure Retail Prices, GCP billing catalog, Vantage
  public data). No purchase and no vendor contract, and the core cannot fetch, so estimation stays
  credential-free by construction rather than by discipline. Residuals: provider manifests still
  carry no real prices, so measured coverage starts near zero, and published list prices are not
  negotiated prices — an estimate against list must say so.)*

### 7.2 Recurring findings — what the corpus says by repetition

Frequency is the signal. Each of these appeared independently across unrelated products.

1. **Preview environments are worthless without data** — 5 independent sources
   ([Release](release.md), [Qovery](qovery.md), [Northflank](northflank.md), [Upsun](upsun.md),
   [Lagoon](lagoon.md)). HoBo's residency and policy layers are what would make production-like data
   in a preview *safe*, which is a stronger position than "we also do previews" and is not currently
   argued anywhere.
2. **A browsable, validating topology surface** — 6+ occurrences, and [Argo CD](argo-cd.md) supplies
   the concrete shape (resource tree + health rollup + live-vs-desired diff). Related to N1 and the
   reason it keeps recurring: it is the same missing surface seen from different angles.
3. **Outbound-only connectivity; the control plane holds no standing credentials** — 5 occurrences
   ([Harness](harness.md)'s Delegate, [Porter](porter.md), [Control Plane](control-plane.md),
   [Flux CD](flux-cd.md), with [Argo CD](argo-cd.md) as the counter-example and
   [Octopus Deploy](octopus-deploy.md)'s polling Tentacle arriving at it independently). This should
   be an architectural commitment, not a deployment detail.
4. **Import what exists** — 7 occurrences, culminating in [StackGen](stackgen.md)'s
   inference-without-declaration and [NetScaler](netscaler.md)'s config → neutral IR → adopt
   mechanism. `hobo import` ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) is
   stronger on paper because adoption is stateful; that advantage is unproven until it ships.
5. **Enforcement beats evaluation.** [Flux CD](flux-cd.md)'s impersonation makes tenant overreach
   *impossible*; a policy pack makes it *detectable*. Where HoBo can push a constraint into the
   provider's own authorization system it should, with `@hobo/policy` as the fallback rather than the
   mechanism.
6. **Defaults decide whether a security model exists.** [OpenShift](openshift.md)'s restricted SCCs
   are on; [Flux CD](flux-cd.md)'s superior isolation is off until someone sets a flag. The second
   protects fewer clusters. HoBo's policy packs should ship restricted.
7. **Bound your own control plane's authority.** [Tailscale](tailscale.md)'s tailnet lock and
   [shoo.dev](shoo.md)'s pairwise subjects are vendors cryptographically limiting what they can do to
   a customer. HoBo asks for more trust than either and offers no equivalent.
8. **Declare, don't infer, the unknowable.** [Infracost](infracost.md)'s usage files and
   [StackGen](stackgen.md)'s inference limits reach the same conclusion from opposite directions:
   inference recovers behaviour, not intent, and least privilege cannot be inferred at all.
9. **Vendors withdraw features from secondary products** ([Atlassian Compass](atlassian-compass.md)
   retiring scaffolding templates with no replacement, within the last year). The strongest available
   argument for manifests living in the customer's repository, and HoBo should make it explicitly.

### 7.3 Adversarial challenges to HoBo's own premises

The captures that argue *against* HoBo, recorded rather than deflected.

- **"Why write a Bindle at all?"** ([StackGen](stackgen.md)) — if a tool can infer infrastructure
  from existing state, declaration looks like ceremony. The answer holds in three parts: inference
  recovers behaviour but not intent; least privilege cannot be inferred; and generated output is a
  starting artifact, not a maintained description. But it is an answer, not a dismissal.
- **"Your feedback loop is worse than ours"** ([System Initiative](system-initiative.md)) —
  continuous qualification and change sets give a designer live feedback on a proposed change. HoBo's
  `can-deploy` gate is a checkpoint, not a loop. This is a fair hit.
- **"Most teams need less than this"** ([Kamal](kamal.md)) — for one application on a few servers,
  HoBo is overhead and Kamal is sufficient. The comparison only favours HoBo once targets are
  heterogeneous, and the positioning should say so rather than implying universal applicability.
- **"You only meter what you deployed"** (the whole FinOps cohort) — HoBo-managed spend is a minority
  of any real bill. The honest claim is *authoritative for HoBo-managed spend, integrable for the
  rest*, never "a FinOps platform".
- **"The abstraction exists only for heterogeneous estates"** ([OpenChoreo](openchoreo.md)) — for a
  Kubernetes-only shop, abstracting over providers buys nothing. Conceded in that capture and worth
  conceding in the positioning.
- **"Distribution beats architecture"** ([Atlassian Compass](atlassian-compass.md),
  [Backstage](backstage.md)) — in the portal category, being already-installed wins accounts
  regardless of design quality. HoBo's response is integration, not imitation.
- **"Incumbency in regulated delivery is near-immovable"** ([Octopus Deploy](octopus-deploy.md)) — the
  audit trail *is* the compliance evidence, and replacing it means re-establishing years of it.

### 7.4 What did not change

- **The intersection bet remains uncontested across all 86 captures.** No single product spans
  provider-abstract authoring + a recorded, scored placement decision + an event-sourced control
  plane + an agent-addressable surface, self-hostable. [Control Plane](control-plane.md) comes
  closest on portability and gets there by owning the runtime, so its portability ends at its edge.
- **Every competitor strength still maps** to a Plan/ADR, composes as a provider, or is a stated
  non-goal. Nothing in the fifty new captures requires a new plane.
- **The deliberate non-goals of §6.5 are re-confirmed**, and one is added: HoBo does not aggregate an
  organization's whole cloud bill and should not claim to.

### 7.5 Implemented and uncommon — what HoBo actually has

The inverse question, asked deliberately: capabilities that are **shipped in `packages/`** and that
few or no captures match. These are the claims safe to make in the present tense.

- **A recorded, scored placement decision** (`match.Decided`, `PortabilityReport`, ADR-0144). Every
  other product in the corpus either names a target or optimizes within one. [Flux Network](flux-network.md)
  is the worked proof: a cheap, low-trust candidate whose impedance is scored rather than assumed.
- **Fail-closed residency evaluation** (`evaluateResidency`, ADR-0146). Nothing in the FinOps or
  networking cohorts treats moving a workload as a jurisdiction decision — and both cohorts move
  workloads.
- **Event-sourced authority with replay** (ADR-0135). [Octopus Deploy](octopus-deploy.md) has the
  best audit trail in the corpus and it records rather than reconstitutes.
- **Typed contracts carrying effects and a resilience profile** (ADR-0136). [CAST AI](cast-ai.md)
  automates spot placement against cluster-wide policy because no per-workload tolerance exists to
  read; this is the input that would make it safe.
- **Traits as first-class operational behaviour** (ADR-0145), where [KubeVela](kubevela.md) is the
  only comparable vocabulary and is Kubernetes-bound.

### 7.6 Design-only differentiation — must not be marketed as shipped

Recorded explicitly so no downstream document upgrades intent into availability:

- **Enforcement at admission** — spend caps, budget refusal ([ADR-0039](../design/adr/02-identity-security.md#adr-0039) §2). *Design-only.*
- **Plan-time cost estimation** ([Plan 5](../design/reliability-observability-cost.md#plan-05)) — [Infracost](infracost.md) ships this today. *Design-only.*
- **Cost-aware placement** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)). *Design-only*, and gated on N5.
- **Heterogeneous, non-Kubernetes cost attribution.** *Design-only*, with no stated `max(requested, usage)`-equivalent rule per target class (see [OpenCost](opencost.md)).
- **`hobo import` stateful adopt-in-place** ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) — stronger than [StackGen](stackgen.md) and [NetScaler](netscaler.md)'s codegen *on paper*. Unproven.
- **Agent-ops legibility loop** — *proof* stage; [InsForge](insforge.md) and [Antimetal](antimetal.md) set the bar.

### 7.7 Borrow rather than rebuild

Mature mechanisms where reimplementation would be waste:

| Mechanism | Source | Posture |
|---|---|---|
| Cost allocation shape and the reconcile-to-the-bill property | [OpenCost](opencost.md) | Conform and export; do not compete on measurement |
| OAM vocabulary and the wadm render target | [KubeVela](kubevela.md) | Standard at the boundary (ADR-0108) |
| Identity-keyed overlay networking | [Tailscale](tailscale.md), [NetBird](netbird.md) | Adopt behind the `mesh` port (ADR-0122) |
| Reconciliation into clusters | [Argo CD](argo-cd.md), [Flux CD](flux-cd.md) | Render target; emit, don't reimplement |
| Extension install/upgrade/dependency resolution | [OpenShift](openshift.md)'s OLM | Reference design for N3 |
| ADC data plane | [NetScaler](netscaler.md) | Provider behind `gateway`; explicit non-goal |

### 7.8 Convergence threats and historical warnings

**Convergence.** Three movements narrow HoBo's differentiation if they continue:
[Harness](harness.md) and [Humanitec](humanitec.md) adding scored, governed placement above delivery;
the IDP cohort ([Backstage](backstage.md), [Port](port.md), [Cortex](cortex.md)) growing from catalog
toward action; and [Control Plane](control-plane.md) already shipping cross-cloud portability by
owning the runtime. None spans the intersection bet today. The defence is the layer above untyped
YAML that [Argo CD](argo-cd.md)'s own users build in Helm values — currently unclaimed, and the
clearest commercial argument in the corpus.

**Historical warnings.** Approaches that were tried and should not be repeated:

- **Dual authoring surfaces** — [Winglang](winglang.md)'s preflight/inflight split is the cautionary
  tale, and the reason [Wasp](wasp.md) is a packaging path rather than a second authoring model.
- **Feature withdrawal from a strategically secondary product** — [Atlassian Compass](atlassian-compass.md)
  retired scaffolding templates with no replacement. Keep the customer's model in the customer's repo.
- **Catalogs that shed their workflows become directories** — same capture, and it applies directly to
  any HoBo surface that lists resources without acting on them.
- **Convenience objects become lock-in** — [OpenShift](openshift.md)'s Routes and BuildConfigs are
  easier than the portable equivalents, which is why they are everywhere. HoBo's provider escapes
  carry the identical risk and are scoped and scored for exactly this reason.
- **A v2 rewrite costs adoption momentum** — [Flux CD](flux-cd.md)'s GitOps Toolkit transition.

### 7.9 Reconciliation record (the completion gate)

Checked on 2026-08-20 against the corpus at this commit:

- **86 canonical captures**, each `contract: v1`, one per product; the two cohort captures
  ([anonymous container hosts](anon-container-hosts.md), [FinOps tooling](finops-tooling.md)) are
  explicitly labelled as cohorts, and the latter is `status: archived` with its five products split
  into canonical captures.
- **Naming collisions resolved.** [Flux CD](flux-cd.md) and [Flux Network](flux-network.md) each
  carry a disambiguation note and cross-link; the `flux` alias remains with Flux Network, its earlier
  claimant. [Upsun](upsun.md) and [StackGen](stackgen.md) are single files under their current names
  with prior names as aliases and `status: renamed` — no stub files.
- **Category pages and the matrix are generated** from front matter, so index drift is structurally
  impossible; every capture's secondary categories carry rows.
- **No source-rich capture was degraded.** Every pre-v1 deep capture was *restructured* — headings
  renamed, contract sections added around the existing material — and the originals' tables,
  impedance findings and mapping legends survive verbatim.
- **Postures are not flattened.** `directness` and `posture` are separate closed vocabularies, so a
  provider target, a render target, an architectural analog and a head-on rival are never reduced to
  one score.
- **Gates green:** `docs:competitors` (86 captures, 0 problems), `test/competitor-docs.test.ts`
  (15 tests), `lint:docs:changed`, `docs:design-lint`.

Follow-up design work — N1 through N5 — is filed as separate issues with the evidence and
dependencies recorded there (HOBO-819 through HOBO-823). This section is a reviewer's finding, not a licence to rewrite the
architecture.

### 7.10 Bottom line and priority order

The corpus is complete, contract-conformant, and less flattering than the last pass. HoBo's design
is broad and its differentiation is real; the recurring risk across 86 captures is not architecture
but **the growing distance between designed and shipped** while comparably-positioned products
ship — [Argo CD](argo-cd.md) shows drift, [CAST AI](cast-ai.md) re-optimizes continuously,
[OpenShift](openshift.md) enforces safe defaults, [Flux CD](flux-cd.md) holds no credentials.

Priority order, revised:

1. ~~**N1 — make drift a named, computed, visible fact** derived from the event log.~~
   **Done** (2026-08-20): `computeDrift` derives a `DriftReport` from the existing
   `DeploymentViewRow` — no new event, no new state ([ADR-0163](../design/adr/03-data-plane.md#adr-0163)).
   The residual is deliberate and recorded there: resolution is per-resource, so a resource that
   exists but is *misconfigured* still reads as in-sync. Closing that needs provider-side state
   readback, which is a larger decision. The topology surface now has something to colour.
2. **Ship restricted policy-pack defaults** (finding 6) — cheap, and it converts a design claim into
   a protection.
3. ~~**N2 — re-evaluable placement.**~~ **Done** (2026-08-20): `evaluateReplacement`
   ([ADR-0164](../design/adr/01-architecture-core.md#adr-0164)) decides *whether* to re-decide and
   names the changed input, so a move is explainable. Two residuals are deliberate: **price is not
   yet an input** (it waits on N5), and **nothing schedules the call** — when to run it is a
   separate decision.
4. **Commit to outbound-only agent connectivity** (finding 3) as an architectural rule with a
   written rationale, and fix the standing contradiction between
   [ADR-0122](../design/adr/07-portability-extensibility.md#adr-0122)'s WireGuard floor and the
   shipped `@hobo/connectivity` default (a live [GAPS.md](../../GAPS.md) finding, restated in the
   [Tailscale capture](tailscale.md)).
5. ~~**N4 — close the estimate-versus-actual loop**, the corpus's clearest unclaimed feature.~~ ✅
   The comparison landed; producing the actuals side remains unbuilt.
6. ~~**N3 — an extension lifecycle for Resource Packs**, before the pack population makes it
   expensive.~~ ✅ The upgrade decision landed; a channel model and pack-to-pack dependencies remain
   unbuilt.
7. ~~**N5 — resource the price-data dependency.**~~ ✅ Both halves are done: cost claims refuse to be
   made on inputs that cannot support them, and the data is resourced by consuming the vendors' own
   published unauthenticated feeds — no purchase, and credential-free by construction.

The §6.4 execution-bar theme (agent-operability and first-run fidelity) stands unchanged and
unaddressed, and every item above is additive to existing machinery rather than a new plane.
