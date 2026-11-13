---
type: Reference
title: "HoBo Implementation Plan — Linear backlog mirror"
description: "- **Created in Linear:** **399 issues** across all **15 projects** (`HOBO-1` … `HOBO-399`,"
tags: [hobo, implementation-plan.md]
---

# HoBo Implementation Plan — Linear backlog mirror

> **Purpose.** This document is the master, branch-sized implementation backlog for the whole
> HoBo platform — the structural mirror of the Linear workspace (team **HoBo**, key `HOBO`). It
> records the full subsystem decomposition: 15 epics and **399** independently-deliverable slices,
> phased M0→M4, with dependency intent. **All slices are now created in Linear** (see *Status*);
> Linear is the authoritative live index, and this doc is the durable plan-of-record.
>
> Every slice is intended to be **independently implementable and provable on its own branch**,
> with full context (why / refs / scope-in / scope-out / acceptance / adversarial / depends-on)
> recorded in the corresponding Linear issue. Where an issue exists, its `HOBO-N` id is given.

## Status (2026-06-24) — COMPLETE

- **Created in Linear:** **399 issues** across all **15 projects** (`HOBO-1` … `HOBO-399`,
  non-contiguous ids), team **HoBo**. Every project is populated; no orphaned/project-less issues.
- **The "cap" was a false alarm.** The `Usage limit exceeded — free issue limit` error was a
  **transient burst rate-limit** triggered by 13 subagents writing to Linear simultaneously — *not*
  a hard workspace cap. Under **paced, single-writer creation** (one `save_issue` at a time, with
  retry-on-throttle), every remaining slice was created with **zero failures**. No plan upgrade was
  needed.
- **Label spread:** 325 `slice`, 109 `security`, 48 `adversarial`, 36 `hardening`, 22 `spike`,
  13 `user-story`, 2 `epic`.
- **All 6 walkthrough role journeys** are filed as `user-story` issues (App dev, Platform eng,
  GitOps, SecOps, SRE, DevOps×2) plus the end-to-end IfC author-flow story.
- **Per-project final tallies:** Providers 34 · Data Plane 32 · Contracts/Policy 32 · Networking 32 ·
  Reliability 31 · Identity 31 · Control Plane 28 · CLI/MCP/DX 28 · WIT Runtime 25 · Harness 24 ·
  Generation 24 · SDK 23 · Portability 22 · Operators/SRE 22 · Foundations 11.

> **Note on markers below.** The per-project sections were authored when ~110 issues existed and the
> rest were still designed-but-uncreated. **Every `▢` slice listed below has since been created in
> Linear.** Linear (team HoBo) is now the authoritative, live index — exact `HOBO-N` ids, current
> status, and the full Why/Refs/Scope/Acceptance/Adversarial/Depends-on bodies live there. This
> document remains the durable *structural* plan: the subsystem decomposition, phasing, and
> dependency intent.

## Post-399 Cross-Cutting Capability Deltas

The original 399-issue mirror remains the baseline for the 15 planned subsystems. New
cross-cutting capabilities discovered after that baseline must not reopen completed epics as
mutable catch-alls. A post-core delta gets its own Linear project and issue family, beginning with
an M0 acceptance record that names scope, authority boundaries, owning lanes, evidence, and blocked
follow-up work.

Minimum durable records for a post-core delta:

- own Linear project or clearly owned Linear issue family;
- M0 acceptance record in `docs/design/` with scope in/out and proof expectations;
- design index row that makes the record discoverable;
- proof README under `docs/design/proofs/` plus executable proof under `src/draft/`;
- traceability row that links issue, design record, and proof; and
- blocked M1-M4 skeleton issues that remain non-actionable until M0 acceptance is Done.

Meta-cloud Broker is the first accepted example of this pattern: HOBO-521 owns the M0 scope record
and proof, and HOBO-524 owns this documentation-pattern hardening.

### Intent-alignment gap review — root [`GAPS.md`](../GAPS.md)

The five-pillar intent review (Nomad × Aspire × Nitric × FinOps × agent-native) keeps a
long-running register at the repo root. Iteration 0 seeds the scaffold (pillar map, method
appendix, empty registers); confirmed findings and remediations append in later commits. Linear
delivery issues for remediations are filed when an iteration confirms them — not in the seed PR.

### HoBo v1 Production Build — staged, pending Linear import

The 399-issue baseline above was executed as **draft proofs** (`src/draft/`); no production code
exists. The production build is scoped as a new Linear **initiative** ("HoBo v1 Production Build"):
seven stage-ordered projects (S0 Toolchain & Contracts Bootstrap → S1 Local SDK & Runtime → S2 First
Cloud + Yard → S3 Agent Autonomy → S4 Multi-Cloud → S5 Forge & Extensibility → S6 Production
Hardening), each closing with an executable gate issue keyed to the requirements Release Criteria,
with later stages opened by M0 acceptance-record issues (the post-core-delta pattern applied to the
build). 79 issues with dependency wiring, plus the companion **Intent-Alignment Gap Remediation**
project (one issue per confirmed [`GAPS.md`](../GAPS.md) remediation), are staged in
`production-build-backlog` (a plan, not kept in the repository) together with an
import runbook — Linear import runs paced single-writer once MCP access is approved. The 15
completed proof projects stay closed; draft material is promotion source only.

### HoBo v1 Production Build — initiative `bc463c40-f5a8-4246-8d71-0d4dd2f6c6c7` — **Active**

The production-build initiative promotes the proven design suite + draft proofs into real
implementation (runnable `packages/*`, real CLI, real control plane), stage-ordered by the
requirements Release criteria (S0/S1 local → S2 first cloud → S3 agent autonomy → S4 multi-cloud →
S5 Forge → S6 hardening). Created 2026-07-01: **7 stage projects, 27 milestones, 87 issues
(HOBO-578…HOBO-665)**, all labeled `production-build`, dependencies wired as blocking relations.
The 15 completed proof projects stay closed; `src/draft/` is promotion source only. Durable mirror:
`production-build-backlog` (a plan, not kept in the repository) (see its Import
record for the full identifier map). S0/S1 slices and every stage-M0 acceptance issue carry full
QA-verified one-shot bodies. S2–S6 slices are blocked by their stage M0 per the post-core delta
pattern above and carry full build-instruction bodies (stage goal + gate, exact packages, context
reading order, dependencies, acceptance sketch, guardrails); each stage M0 is required — per its
pinned handoff comment — to sharpen those bodies in place into full one-shot checklists before it
closes, so executing agents build the real app from the issues alone.

Companion project **Intent-Alignment Gap Remediation** (`292efb1a-669c-4d79-93df-901d134b4832`,
same initiative): 25 issues (HOBO-666…HOBO-690), one per confirmed finding of the gap-review
iteration 1 recorded in [`GAPS.md`](../GAPS.md) (17 gaps + 8 drifts; REM-001…REM-025), labeled
`intent-alignment`, milestoned by remediation class (ADR & scope records · design-doc amendments ·
competitor & standards research · hygiene & traceability). Each issue's executable spec is its
GAPS.md REM entry; all changes are documentation-level. The review loop itself is Linear-documented
work (milestone "Review iterations (engine)": HOBO-691 iteration 2, HOBO-692 closure sweeps until
an iteration confirms zero new findings), so the multi-iteration audit continues without this
session.

### Meta-cloud Broker - `3b77f153-55ea-46e1-b1d5-2683901576ba` - **Backlog**

The Meta-cloud Broker project owns the hosted broker authority boundary: Contract Manifest
validation against Broker Environment snapshots, Mapping Contracts from HoBo-native services to
cloud/IaC configurations, Resolution Receipts, Resolution Rejections, and Yard receipt handoff.
Its durable M0 proof remains
[`meta-cloud-broker-scope-contract`](../src/draft/exp-proofs/api/meta-cloud-broker-scope-contract/README.md).

- HOBO-521 - M0: Define Meta-cloud Broker scope and acceptance - M0 - hardening - 3.
- HOBO-522 - M1: Define broker artifact schemas and validation contract - M1 - slice/hardening - 3.
- HOBO-523 - M1: Prove Yard consumes Resolution Receipts without re-resolving broker authority - M1 - slice/adversarial - 3.
- HOBO-524 - M1: Update docs pattern for post-core cross-cutting capabilities - M1 - hardening - 2.
- HOBO-525 - M2: Implement deterministic meta-cloud broker resolution contract proof - M2 - slice - 5.
- HOBO-526 - M2: Prove provider/catalog mapping publication into Broker Environment snapshots - M2 - slice - 5.
- HOBO-527 - M2: Add admin controls for broker environment proposals and approvals - M2 - slice/security - 5.
- HOBO-528 - M3: Adversarial broker rejection matrix for stale, incompatible, and ambiguous mappings - M3 - adversarial/hardening - 5.
- HOBO-529 - M3: Adversarial receipt integrity and replay/tamper refusal - M3 - adversarial/security - 5.
- HOBO-530 - M4: Prove hosted broker GA handoff evidence - M4 - slice - 3.

All M1-M4 issues are blocked by HOBO-521 until the M0 acceptance record is accepted. The completed
Contracts, Policy & Governance, Control Plane, and Providers/IaC projects have status updates
pointing to this delta while preserving their completed scope.

### Provenance — the subagents that authored each subsystem

Each subsystem was authored by a dedicated subagent holding the **full templated issue bodies**.
For reference / future edits:

| Subsystem | Resume agent id |
|---|---|
| SDK & Authoring | `a847c24fd8bd78897` |
| Control Plane | `a8ede18083a2f1eb5` |
| Identity / Auth / XAA | `a220ac13de53d55c0` |
| Data Plane | `af0dcfe75e0bcf73f` |
| Providers, IaC & Build | `a88a07204246756d7` |
| Contracts, Policy & Governance | `a4b2498bbdb785470` |
| Networking / DNS / Relay | `a463d98e6f5a2f0b2` |
| Reliability, Obs & Cost | `aae77008f7478156c` |
| Progressive Delivery (Harness) | `a96591ab7d817cbde` |
| Generation & AI Safety | `aad818bce031b8c8f` |
| Portability & Registry | `ad73895631ee8e54c` |
| Operators & SRE (Crew) | `aae800f07b9f1ea89` |
| CLI, MCP & DX | `a83b1ef68ff93e5cd` |

## Legend

- **Phase:** `M0` Contracts → `M1` Skeleton → `M2` Core → `M3` Hardening → `M4` GA (decision record: [ADR-0116](design/adr/07-portability-extensibility.md#adr-0116)).
- **Labels:** `slice` (implementable deliverable), `spike` (time-boxed research/decision),
  `hardening` (contract-finalisation / normalisation), `security`, `user-story` (end-to-end role
  flow), `adversarial` (failure/abuse/edge case), `epic` (tracking parent).
- **Estimates:** Fibonacci `1/2/3/5/8`.
- `✅ HOBO-N` = listed with its assigned id. `▢` = was designed-but-uncreated when this doc was
  first written; **all `▢` slices are now created in Linear** (see Status above) — consult Linear
  for the exact `HOBO-N`.

---

## 1. Foundations, Build & Conformance Harness — `648882d1-6039-4ed5-b771-6df8fd1a96d4` — **11/11 ✅**

- ✅ HOBO-1 — Monorepo + package skeleton with enforced boundary lint
- ✅ HOBO-2 — `@hobo/core`: shared types, DI container, Capability Manifest & EventEnvelope
- ✅ HOBO-3 — `@hobo/wit`: WIT toolchain + `hobo:sdk` package skeleton + generated bindings
- ✅ HOBO-4 — `@hobo/componentize`: build a TS service to a wasm component + OCI artifact
- ✅ HOBO-5 — `@hobo/conformance`: port-suite harness with golden-IR capture + replay
- ✅ HOBO-6 — CI fabric (keyless OIDC) + examples-as-E2E fixtures
- ✅ HOBO-7 — Sign artifacts + attach SLSA provenance on publish; verify on install
- ✅ HOBO-8 — HARDENING: finalize the canonical `hobo` CLI verb surface + reconcile all docs
- ✅ HOBO-9 — HARDENING: finalize public SDK API contracts (`.allow` narrowing, connector naming, connection-scoped tokens, policy-owned inferred-Camp approval)
- ✅ HOBO-10 — HARDENING: glossary/terminology/namespace consistency sweep + doc-lint
- ✅ HOBO-11 — HARDENING: ADR ↔ implementation traceability audit (every decision maps to ≥1 issue)

Dependency wiring: 2←1, 3←1, 4←3, 5←1&2, 6←4&5, 7←4.

---

## 2. WIT & Component-Model Runtime (the membrane) — `19527db6-5b34-42e1-bf70-e8b61bd95fdf` — **25/25 ✅**

- ✅ HOBO-12 — Spike: choose wRPC + WIT version baseline and vendoring/pinning policy
- ✅ HOBO-13 — Author the `hobo:runtime` primitive interfaces (workflow/step/actor/saga)
- ✅ HOBO-14 — Author `hobo:queue` / `hobo:scheduler` / `hobo:blob-events` capability interfaces
- ✅ HOBO-15 — Vendor and pin the reused `wasi:*` interfaces + a round-trip conformance check
- ✅ HOBO-16 — Author the `hobo:sdk` aggregate WIT package + reverse-extraction tool
- ✅ HOBO-17 — Build the Wasmtime runtime-local component-host skeleton (link table + host)
- ✅ HOBO-18 — Wire in-process links over the wRPC abstraction (transport-agnostic calls)
- ✅ HOBO-19 — Implement deny-by-default capability enforcement + usage-inferred grants
- ✅ HOBO-20 — Implement the Camp EventStore runtime port + durability conformance assertions
- ✅ HOBO-21 — Implement the ActorHost runtime port (single-writer leases + fencing)
- ✅ HOBO-22 — Implement the Queue + Clock runtime ports (at-least-once + deterministic time)
- ✅ HOBO-23 — Implement the Streamer runtime port (per-run realtime read/write)
- ✅ HOBO-24 — Implement deadline propagation across links (every link a timeout boundary)
- ✅ HOBO-25 — Implement membrane backpressure + the partial/ambiguous-failure taxonomy
- ✅ HOBO-26 — Implement wire-version negotiation + below-floor link rejection
- ✅ HOBO-27 — Implement the NATS/JetStream lattice transport (cross-process + cross-host)
- ✅ HOBO-28 — Package the component-host inside an OCI container (the zero-infra flow)
- ✅ HOBO-29 — Build the `@hobo/conformance/component-host` suite (the portability boundary)
- ✅ HOBO-30 — Build the `@hobo/conformance` runtime-port suite (durability invariants)
- ✅ HOBO-31 — Spike: idiom-layer semantics annex (error/cancellation/IfC test vectors)
- ✅ HOBO-32 — Build the `@hobo/conformance/sdk` idiom-layer parity gate (TS first)
- ✅ HOBO-33 — Author the preview `wasi:websocket` + `hobo:websocket` extension interfaces
- ✅ HOBO-34 — Wire `hobo:websocket` fan-out through the Streamer (Yard never on the path)
- ✅ HOBO-35 — Spike: certify an opt-in component-host adapter (SpinKube or provider-managed)
- ✅ HOBO-36 — Implement host version pinning + gated upgrade with upcaster

---

## 3. SDK & Authoring (IfC / bindles) — `883a1938-3727-4a9c-8e71-18fa4605d8a9` — **complete · 23 issues**

Created:
- ✅ HOBO-37 — Define the `@hobo/bindles` resource catalog declaration surface (resource → WIT port) · M0 · slice · 5
- ✅ HOBO-38 — Define and version the `hobo.manifest/v1` schema (the deployment IR) · M0 · slice · 5
- ✅ HOBO-40 — Define the varlock-style declarative config/secrets schema surface · M0 · slice/security · 3
- ✅ HOBO-43 — Define the `connector()` declaration + typed-client surface (XAA authoring) · M0 · slice/security · 5
- ✅ HOBO-49 — Define the `bind` reference + Aspire-style wiring surface · M0 · slice · 5
- ✅ HOBO-52 — Define the provider-specific options pattern (`.with(...)`, prefer/require) · M0 · slice · 3
- ✅ HOBO-58 — Spike: per-scope npm namespace partitioning · M0 · spike · 2
- ✅ HOBO-62 — Implement the first-class topology objects (bindle/camp/yard/junction) · M1 · slice · 5
- ✅ HOBO-67 — Implement the resource-collection engine (run-to-collect → manifest IR) · M2 · slice · 8
- ✅ HOBO-70 — Implement usage-inferred permissions + `.allow()` narrowing · M2 · slice/security · 5
- ✅ HOBO-75 — Implement static-analysis collection-coverage gate · M2 · slice/adversarial · 5
- ✅ HOBO-79 — Implement IfC handler/trigger attachment (http/topic/bucket/schedule/queue/ws/job) · M2 · slice · 5
- ✅ HOBO-83 — Implement XAA scope inference (called operations → least-privilege scopes) · M2 · slice/security · 5
- ✅ HOBO-88 — Implement the SDK codegen surface (checked-in `_generated/`) · M2 · slice · 8
- ✅ HOBO-98 — Implement the end-user `hobo:auth` authoring surface (`auth()` + `useAuth`/`ctx.user`) · M2 · slice/security · 5
- ✅ HOBO-106 — Implement the idiom-layer ergonomics (fluent L3/L4 lowering to `hobo:sdk` + manifest IR) · M2 · slice · 5

Remaining (cap-blocked):
- ▢ Implement the manifest schema versioning + upcaster hook (`hobo.manifest/v1 → vN`) · M3 · slice/hardening · 3
- ▢ Implement the opt-in paradigm idiom packages (`@hobo/sql` / `@hobo/vector` / `@hobo/graph` / `@hobo/document`) · M2 · slice · 5
- ▢ Implement the local-dev/test authoring surface (`hobo dev` local Camp + testRuntime determinism harness) · M2 · slice · 3
- ▢ Implement the Hobo Code DSL front-end (L1 declarative + L2 stubs → manifest IR) · M2/M3 · slice · 8
- ▢ User-story: end-to-end IfC author flow (declare → collect → infer → codegen → manifest) green on a sample Bindle · M3 · user-story · 5
- ▢ Spike: idiom-layer ergonomic boundary for non-TS round-trip (reverse-extraction → idiom skeleton parity) · M1 · spike · 2
- ▢ HARDENING: freeze `@hobo/bindles` public API + manifest-IR contract (narrowing/coverage/XAA edges) · M3 · hardening/adversarial · 3

Wiring to add: 67←37,38,49; 70←67; 75←67; 79←37,67,49; 83←43,67,70; 88←67,49,52; 106←67.

---

## 4. Control Plane: Planner, Matching & Orchestrator — `0b863d00-e180-4ad1-a8d8-a58049252a71` — **complete · 28 issues**

Created:
- ✅ HOBO-39 — Define control-plane event schemas (planning/matching/reconcile/dispatch log) · M0 · slice · 3
- ✅ HOBO-41 — Define the DeploymentPlan / ResourcePlan DAG IR types · M0 · slice · 2
- ✅ HOBO-45 — Define the Resource Definition + Driver port interfaces · M0 · slice · 3
- ✅ HOBO-47 — Define CloudProvider / Capability / IacProvider port interfaces · M0 · slice · 3
- ✅ HOBO-50 — Define the Deployment Set + Delta projection model · M0 · slice · 2
- ✅ HOBO-55 — Spike: Matching specificity-scoring + lexicographic tie-break algorithm · M1 · spike · 3
- ✅ HOBO-59 — Spike: self-host bootstrap ordering (the chicken-and-egg) · M1 · spike · 3
- ✅ HOBO-61 — Planner skeleton: collect resources + build dependency DAG from manifest IR · M1 · slice · 3
- ✅ HOBO-64 — Matching engine skeleton: gather → filter → score → pick + emit `match.Decided` · M1 · slice · 3
- ✅ HOBO-68 — ResourceActor FSM skeleton (durable, event-sourced lifecycle grain) · M1 · slice · 3
- ✅ HOBO-72 — Executor skeleton: dispatch an IacProgram to a sandboxed runner + stream `exec.*` · M1 · slice · 3
- ✅ HOBO-73 — Orchestrator choreography skeleton: spawn actors, self-activate on deps' Provisioned · M1 · slice · 3
- ✅ HOBO-78 — Capability negotiation (full/partial/none; require/prefer) + `deployment.PlanRejected` · M2 · slice · 3
- ✅ HOBO-81 — Region/colocation + objective ranking (cost|latency|single-provider|carbon) · M2 · slice · 5
- ✅ HOBO-82 — Mapping-as-sugar compiler: `camp()` inline mapping → default Resource Definitions · M2 · slice · 3
- ✅ HOBO-86 — Author-time static capability feedback + remediation suggestion · M2 · slice · 3
- ✅ HOBO-95 — ResourceActor idempotent reconcile loop (load → diff → apply → outputs) · M2 · slice · 5
- ✅ HOBO-97 — Driver-dispatch routing (terraform|template|echo|container|custom-webhook) · M2 · slice · 3
- ✅ HOBO-103 — Delta → Set apply + incremental reconcile (only changed nodes) · M2 · slice · 5
- ✅ HOBO-109 — Choreographed compensation: reverse-dependency destroy on rollback · M2 · slice · 5

Remaining (cap-blocked):
- ▢ Implement the self-host bootstrap saga (the control plane runs on itself) · M1/M2 · slice · 5
- ▢ Implement the Dispatcher (placement/dispatch, CreditLedgerView, `dispatch.Decided`) · M2 · slice · 5
- ▢ Implement the drift-detection loop (refresh → DriftReport → reconcile) · M2 · slice · 3
- ▢ Implement adopt-in-place + external resources (ADR-0041) · M2 · slice · 3
- ▢ ADVERSARIAL: drift reconciliation conflicts + orphan sweep · M3 · slice/adversarial · 5
- ▢ ADVERSARIAL: partial-realize rollback (created-but-not-in-state) · M3 · slice/adversarial · 5
- ▢ HARDENING: Dispatcher reservation / double-spend CAS safety · M3 · slice/hardening · 3
- ▢ GA: DeploymentView saga-graph projection + correlationId E2E · M4 · slice · 5

Wiring present: 61←41; 64←45,55; 73←68; 95←68,72; 109←95,73.

---

## 5. Providers, IaC & Build Adapters — `daa89960-b663-42f4-8cca-67a90d979beb` — **complete · 34 issues**

Created:
- ✅ HOBO-87 — Define the provider-package authoring contract (factory + `.with` builders + client + manifest) · M0 · slice · 5
- ✅ HOBO-93 — Implement provider default Resource Definitions + equivalence map + `.register()` · M0 · slice · 5
- ✅ HOBO-102 — Build the `@hobo/conformance` provider-capability suites (the provider-conformance gate) · M0 · slice/security · 8
- ✅ HOBO-108 — SPIKE: the cross-cloud equivalence-class & capability-resolver model · M0 · spike · 3

Remaining (cap-blocked):
- ▢ Define the `realize()` → IacProgram + BuildSpec emission contract · M0 · slice
- ▢ Emit a PortabilityReport from `realize()` (non-portable surface) · M0 · slice
- ▢ Define the provider Capability Manifest (capabilities/auth/`cost.json`) authoring + publication · M0 · slice
- ▢ `iac-pulumi` (primary; Automation API: preview/apply/destroy/refresh) · M1 · slice
- ▢ Reference local/container provider (the zero-infra floor) · M1 · slice
- ▢ Per-resource IaC state model + pluggable state backend · M1 · slice
- ▢ `build-wasm` adapter · M1 · slice
- ▢ Runner/BuildMachine provider contract + self-hosted adapter · M1 · slice
- ▢ `provider-aws` · M2 · slice
- ▢ `provider-azure` · M2 · slice
- ▢ `provider-gcp` · M2 · slice
- ▢ `provider-cloudflare` · M2 · slice
- ▢ `provider-hetzner` · M2 · slice — **landed:** catalog + Cloud Server/LB/Volume resolvers (fake-transport proof); five slots empty, no managed data services
- `provider-digitalocean` · M2 · slice — **landed;** not in this doc's original design list. Catalog + resolvers for 9 of 14 products (fake-transport proof)
- `provider-hostinger` · M2 · slice — **landed;** not in this doc's original design list. Adopt-and-converge only: allocation there is a billing order
- ▢ `provider-fly` · M2 · slice
- ▢ `provider-vercel` · M2 · slice
- ▢ `provider-kubernetes` (+ Crossplane substrate) · M2 · slice — **partly landed:** provider parity (manifest, Yard catalog of built-ins, yard event-fold, apiserver resolvers for 6 of 7) plus the existing placement driver; the Crossplane substrate is still open
- ▢ `iac-opentofu` · M2 · slice
- ▢ `iac-crossplane` · M2 · slice
- ▢ `iac-cdktf` (import-only) · M2 · slice
- ▢ `build-dagger` (container) · M2 · slice
- ▢ `build-packer`/`firecracker`/`vagrant` (VM/microVM) · M2 · slice
- ▢ Driver-taxonomy adapters (template/echo/container/custom-webhook) · M2 · slice
- ▢ `generateProvider` (AI-generated providers loop) · M2 · slice
- ▢ SPIKE: `generateProvider` correctness/determinism · M2 · spike
- ▢ ADVERSARIAL: `realize()` partial-apply/rollback/compensation · M3 · slice/adversarial
- ▢ ADVERSARIAL: drift between IaC state and reality · M3 · slice/adversarial
- ▢ ADVERSARIAL: malicious/incorrect third-party provider package · M3 · slice/adversarial/security
- ▢ Adopt-in-place importers (`hobo import` / external + adopted nodes) · M3 · slice
- ▢ Signed Resource Packs distribution for providers · M4 · slice
- ▢ Multi-cloud-shop provider E2E (same Bindle, ≥2 providers) GA gate · M4 · slice/user-story

Wiring: each concrete provider/`generateProvider` ← HOBO-87 + HOBO-102; HOBO-102 & HOBO-93 ← HOBO-87; `iac-pulumi`/build adapters ← `realize()` emission contract.

---

## 6. Identity, Auth, Secrets & Cross-App Access (XAA) — `fd8de913-fe73-4b49-8388-28c5f19cc95c` — **complete · 31 issues**

Created:
- ✅ HOBO-44 — Specify the JWT-SVID token format and trust-domain naming scheme · M0 · slice/security · 3
- ✅ HOBO-48 — Define the `auth.json` flow schema and OIDC-federation trust contract · M0 · slice/security · 3 (←44)
- ✅ HOBO-54 — Specify the ID-JAG token-exchange wire contract (RFC 8693 + RFC 7523) · M0 · slice/security · 5 (←44,48)
- ✅ HOBO-56 — Define the unified PrincipalRef + RBAC subject model contract · M0 · slice/security · 3 (←44)
- ✅ HOBO-63 — Define the `hobo:auth` consumer-driven contract and dev-fixture principal shape · M0 · slice/security · 3 (←56)
- ✅ HOBO-66 — Define the `identity.*`/`token.*`/`session.*` event families + CredentialAudit projection · M0 · slice/security · 3 (←56)
- ✅ HOBO-71 — Stand up the Yard Identity OIDC issuer + JWKS endpoint with genesis signing key in KMS · M1 · slice/security · 5 (←44)
- ✅ HOBO-77 — Build the workload-attestation intake (image digest + host launch measurement) · M1 · slice/security · 5 (←44)
- ✅ HOBO-84 — Build the token-broker skeleton (`ctx.token` / request_token path) · M1 · slice/security · 5 (←48,66)
- ✅ HOBO-90 — Issue JWT-SVIDs bound to the attested workload with least-privilege scope · M2 · slice/security · 5 (←71,77)
- ✅ HOBO-99 — Implement SVID auto-rotation within TTL for long-running agents · M2 · slice/security · 3 (←90)
- ✅ HOBO-110 — Implement OIDC-federation token exchange to provider STS · M2 · slice/security · 8 (←84,90)

Remaining (cap-blocked):
- ▢ Secretless config/secret resolution ladder + secrets port adapter · M2 · slice/security
- ▢ `hobo:auth` JWKS verify → `ctx.user` · M2 · slice/security
- ▢ Event-sourced sessions + revocation / sign-out-everywhere · M2 · slice/security
- ▢ ID-JAG outbound mint (HoBo as XAA requester) · M2 · slice/security
- ▢ ID-JAG inbound (HoBo apps as XAA resource servers) · M2 · slice/security
- ▢ `connector().connection().token()` broker backing + usage-inferred scope · M2 · slice/security
- ▢ RBAC role binding via SSO/SCIM · M2 · slice/security
- ▢ mTLS SVID cert issuance/rotation for service-to-service · M2 · slice/security
- ▢ HoBo Relay SVID-auth reverse tunnel · M2 · slice/security
- ▢ ADVERSARIAL: SVID issuance to a compromised/forked workload (cross-tenant mint) · M3 · adversarial/security
- ▢ ADVERSARIAL: ID-JAG confused-deputy in XAA · M3 · adversarial/security
- ▢ ADVERSARIAL: token replay (nonce/audience/short-TTL) · M3 · adversarial/security
- ▢ ADVERSARIAL: secret-zero bootstrap trust · M3 · adversarial/security
- ✅ HOBO-266 — SPIKE: SVID rotation under network partition · M3 · spike/security · 3 (←HOBO-99)
- ▢ SPIKE: ID-JAG token-exchange threat model · M3 · spike/security
- ▢ HARDENING: static-key escape-hatch (TTL/rotation/audit) · M3 · hardening/security
- ▢ HARDENING: genesis Org-Admin + offline break-glass override · M3 · hardening/security
- ▢ OCSF audit export for identity/token events · M4 · slice/security
- ▢ Broker HA + credential-cache renewal-grace window · M4 · hardening

Wiring present: 48←44; 54←44,48; 56←44; 63←56; 66←56; 71←44; 77←44; 84←48,66; 90←71,77; 99←90; 110←84,90.

---

## 7. Data Plane: Event Sourcing, CQRS & Reactivity — `7c8e15ca-8587-4986-b278-8dc2854aa11a` — **complete · 32 issues**

Created:
- ✅ HOBO-42 — Define the typed domain event-body contract (WIT-record payloads, Protobuf wire) · M0 · slice · 3
- ✅ HOBO-46 — Define the `hobo:projection` port + `projection.*` event family contract · M0 · slice · 3
- ✅ HOBO-51 — Define the materialization + `subscription.*` + `data.Changed` reactive contract · M0 · slice · 2
- ✅ HOBO-53 — Define the tunable-consistency-level + reactivity-class contract · M0 · slice · 2
- ✅ HOBO-57 — Implement event-body upcasters + the golden-replay corpus can-deploy gate · M0 · slice/hardening · 5
- ✅ HOBO-60 — SPIKE: prove the replay==live equivalence guarantee for folds + the Reactor · M0 · spike · 3
- ✅ HOBO-65 — SPIKE: generate the GraphQL-facade schema from materializations + WIT-record read-models · M0 · spike · 3
- ✅ HOBO-69 — Implement the CQRS write path: command → aggregate (write-model fold) → event · M1 · slice · 5 (←21,42)
- ✅ HOBO-74 — Implement projection declaration + native log-backed standing projection (default sink) · M1 · slice · 5 (←46,60)
- ✅ HOBO-76 — Implement the default read surface: subscribe + from/RX operators + replay-then-live · M1 · slice · 5
- ✅ HOBO-80 — Implement the Reactor: inverted read-set index, snapshot@seq recompute, diff + push · M1 · slice · 8 (←74,23,60)
- ✅ HOBO-85 — Implement reads-your-writes: per-stream seq-map vector advance + monotonic ordering · M2 · slice · 5 (←80,69)
- ✅ HOBO-92 — Implement the GraphQL facade: reducers, resolvers over materializations, cached snapshots · M2 · slice · 8 (←65,80)
- ✅ HOBO-96 — Implement the escape hatches: `snapshot()`, `repo.get/find`, `view` + predicate DSL · M2 · slice · 5
- ✅ HOBO-107 — Implement cursor-based pagination over the consistent snapshot@seq · M2 · slice · 3

Remaining (cap-blocked):
- ▢ Relational (Postgres) projection-sink adapter + change-feed → `data.Changed` · M2 · slice
- ▢ Document (Mongo) projection-sink adapter + change streams · M2 · slice
- ▢ Generalize the `change-feed` capability to a sink-port capability + conformance suite · M2 · slice
- ▢ Snapshots + compaction (snapshot-and-truncate domain streams; never-compact audit streams) · M2 · slice
- ▢ Full-text search as the reactive query side of `data` · M2 · slice
- ▢ `@hobo/sql` + `@hobo/document` idiom packages · M2 · slice
- ▢ `@hobo/vector` + `@hobo/graph` search-extension packages + `embed` capability · M2 · slice
- ▢ Optimistic updates (client-side patch until authoritative push) · M2 · slice
- ▢ Cross-Camp bounded-staleness projections · M3 · slice
- ▢ `.raw(driver => …)` escape hatch (read-only on projected sinks; portability/tenant debt flagged) · M3 · slice
- ▢ ADVERSARIAL: projection lag/consistency (`projection.Lagged` bounds → policy input) · M3 · adversarial
- ▢ ADVERSARIAL: snapshot/replay divergence (snapshot is cache, never source of truth) · M3 · adversarial
- ▢ ADVERSARIAL: out-of-order events + cross-cutting fan-out coalescing/backpressure · M3 · adversarial
- ▢ ADVERSARIAL: poison events → quarantine fact + deterministic skip · M3 · adversarial
- ▢ ADVERSARIAL: PII / right-to-erasure in an append-only log (crypto-shred + forbid-invariants-over-forgettable-fields) · M3 · adversarial/security
- ▢ Auth-state + flag-state in the read-set (`session.Revoked`/`flag.Changed` live re-push) · M3 · slice
- ▢ Projection rebuild-from-zero at scale (checkpointed/resumable/shard-parallel cutover) · M4 · slice

---

## 8. Contracts, Policy & Governance — `c98c644d-e132-4062-b44b-fcdfd7db6d9d` — **complete · 32 issues**

Created:
- ✅ HOBO-91 — Define the HoBo Policy IR + decision request/response schema · M0 · slice/security · 3
- ✅ HOBO-100 — Define the policy-engine WIT port + built-in TypeScript-rules contract · M0 · slice/security · 3 (←91)

Remaining (cap-blocked):
- ▢ Contract IR + four modes · M0 · slice
- ▢ contract-engine WIT port + PACT-as-built-in · M0 · slice
- ▢ `can-deploy` compatibility-matrix engine + `compat.Gate*` events · M1 · slice
- ▢ Observed-contract trace-mining + promotion gate (migration window + sample-coverage) · M2 · slice
- ▢ Unified Gatekeeper / `hobo verify` composite decision · M2 · slice
- ▢ Obligation engine as durable event-sourced effects/sagas + deadline-escalation · M2 · slice
- ▢ Policy phases author→repair rule surface · M2 · slice
- ▢ Policy packs: signed, versioned, scoped, federated via Junction · M2 · slice/security
- ▢ `hobo:*` control-plane action taxonomy + completeness build-gate · M1 · slice
- ▢ RBAC role/binding model + built-in roles + SSO/SCIM binding + no-self-escalation · M2 · slice/security
- ▢ Default role→action binding matrix + SoD approval obligations · M2 · slice/security
- ▢ Genesis Org-Admin + offline break-glass override · M3 · slice/security
- ▢ SPIKE: deny-ceiling composition algebra (deny-overrides + scope-monotonic + most-restrictive tie-break) · M1 · spike/security
- ▢ Policy authoring surface + waiver path (`policy.WaiverRequested/Approved`) · M2 · slice
- ▢ `policy.Decided` event family + OCSF audit export of policy decisions · M2 · slice/security
- ▢ Feature-flag governance: policy-gated flips, prod kill-switch approval, auto-revert obligation · M2 · slice/security
- ▢ Data-classification → residency/retention obligations at can-deploy + runtime · M2 · slice/security
- ▢ Guardrail policy-gated step + four-lens model/prompt promotion gate · M2 · slice/security
- ▢ Cost/quota as policy input (deny-ceiling on spend) · M2 · slice
- ▢ Cross-Yard detective attestation of policy-engine builds · M3 · slice/security
- ▢ ADVERSARIAL: policy bypass via unmapped action · M3 · adversarial/security
- ▢ ADVERSARIAL: privilege escalation through ceiling gaps · M3 · adversarial/security
- ▢ ADVERSARIAL: conflicting federated mandatory packs · M3 · adversarial/security
- ▢ ADVERSARIAL: fail-open vs fail-closed under evaluator outage · M3 · adversarial/security
- ▢ ADVERSARIAL: policy-as-code supply-chain trust (registry bundle-import / pack signing) · M3 · adversarial/security
- ▢ HARDENING: control-plane authz p99 + decision-cache TTL + revocation-propagation bound · M3 · hardening/security

---

## 9. Networking, Connectivity, DNS & Relay — `70e2d1f1-c7fc-4dd0-bff5-87c0b7b83dda` — **complete · 32 issues**

Created:
- ✅ HOBO-89 — Define the connectivity-tier IR and the 5-tier model contract · M0 · slice/epic · 3
- ✅ HOBO-94 — Define the Yard topology / connectivity-manifest model · M0 · slice · 3 (←89)
- ✅ HOBO-101 — Define the `hobo:dns` capability port contract · M0 · slice · 3 (←89)
- ✅ HOBO-105 — Define the gateway / ingress port contract · M0 · slice · 2

Remaining (cap-blocked):
- ▢ DNS validation gate + `domain.*` events · M1 · slice/security (←101)
- ▢ mTLS data-path contract (SVID-keyed) · M1 · slice/security (←89)
- ▢ Tier 1: native private networking + endpoint resolution from `bind` · M2 · slice
- ▢ Tier 2: cross-region backbone · M2 · slice
- ▢ Tier 3: PrivateLink-style private connectivity · M2 · slice
- ▢ Tier 4: overlay mesh · M2 · slice
- ▢ Tier 5: public + mTLS · M2 · slice
- ▢ ACME DNS-01 cert issuance (consume Identity) · M2 · slice/security
- ▢ Domain resource + 4 validation checks (multi-vantage, TTL-propagation, ACME, health) · M2 · slice/security
- ▢ Staged/canary cutover with auto-rollback · M2 · slice
- ▢ Routing policies (failover/weighted/latency/geo/cost) · M2 · slice
- ▢ Junction cross-cloud connectivity inference + federate-each-Yard-its-half · M2 · slice
- ▢ HoBo Relay (outbound-443 reverse tunnel, SVID-auth, multi-target) · M2 · slice/security
- ▢ Internal-CA / private-ACME for air-gapped Yards · M3 · slice/security
- ▢ Egress/latency cost feedback to Planner + topology-graph tier annotation · M3 · slice
- ▢ Per-app-tenant routing over domain/dns/gateway · M3 · slice
- ▢ SPIKE: Junction cross-cloud inference correctness · M2 · spike
- ▢ SPIKE: DNS validation-gate threat model · M2 · spike/security
- ▢ ADVERSARIAL: DNS rebinding/spoofing past the gate · M3 · adversarial/security
- ▢ ADVERSARIAL: Relay as an SSRF pivot · M3 · adversarial/security
- ▢ ADVERSARIAL: split-horizon / partition connectivity · M3 · adversarial
- ▢ ADVERSARIAL: topology-override conflicts · M3 · adversarial

Wiring present: 94←89; 101←89.

---

## 10. Reliability, Observability & Cost (FinOps) — `b36b40c8-059f-4d29-8aa1-0a80c852761a` — **complete · 31 issues**

Created:
- ✅ HOBO-104 — Define the telemetry envelope + boundary-export schema (OTEL/CloudEvents/OCSF) · M0 · slice/epic · 3 (←20)

Remaining (cap-blocked):
- ▢ Define the SLO-as-code contract (OpenSLO-aligned SLI/objective/error-budget + `slo.*`) · M0 · slice · 3
- ▢ Define the CreditLedger + metering cost-signal contract (`cost.json`, `meter.*`/`spend.*`/`credit.*`) · M0 · slice · 3
- ▢ Define the system-level failure-taxonomy → strategy map contract · M0 · slice · 2
- ▢ Propagate W3C trace context through envelopes + span scaffolding · M1 · slice · 3
- ▢ MeteringView projection skeleton · M1 · slice · 3
- ▢ CreditLedgerView projection skeleton (effective marginal cost @seq, determinism-pinned) · M1 · slice · 3
- ▢ Choreography saga-engine skeleton · M1 · slice · 5
- ▢ OTEL traces pipeline + OTLP export · M2 · slice · 5
- ▢ Metrics catalog + pipeline (control-plane + data-plane RED + wasm runtime) · M2 · slice · 5
- ▢ Structured logs pipeline (`ctx.log` correlation + live tail) · M2 · slice · 3
- ▢ Run Inspector projection (saga/step/actor timeline, time-travel, replay/diff) · M2 · slice/user-story · 5
- ▢ Saga compensation engine (reverse-topo, idempotent compensations, no-go threshold) · M2 · slice · 5
- ▢ Deployment-strategy saga templates (recreate/blue-green/canary/progressive + auto-rollback) · M2 · slice · 5
- ▢ SLO computation + multi-window burn-rate engine · M2 · slice · 3
- ▢ AlertManager-style alerting model (group/dedup/silence/inhibit/route, `alert.*`) · M2 · slice · 5
- ▢ CreditLedger Dispatcher + `maximize-credits` objective (reservation-CAS, hysteresis) · M2 · slice · 5
- ▢ Budgets/caps/quota enforcement through the policy plane · M2 · slice · 3
- ▢ Showback attribution (tenant→Camp→Bindle→run/agent/team) · M2 · slice/user-story · 3
- ▢ OpenInference AI-method telemetry + trajectory/live-eval stream (`eval.*`) · M2 · slice · 5
- ▢ AvailabilityView — architecture-derived availability estimate vs observed SLO · M2 · slice · 3
- ▢ Error-budget deploy-gate + auto-revert obligation · M3 · slice/hardening · 3
- ▢ Runaway-spend circuit-breaker saga · M3 · slice/hardening · 3
- ▢ Cost-driven graceful-degradation saga (`costAvailabilityProfile`) · M3 · slice/hardening · 5
- ▢ ADVERSARIAL: compensation-of-compensation escalation → needs-human · M3 · adversarial · 3
- ▢ ADVERSARIAL: metric cardinality explosion / observability-cost runaway · M3 · adversarial/hardening · 3
- ▢ ADVERSARIAL: SLO-gaming resistance · M3 · adversarial · 3
- ▢ ADVERSARIAL: cost attribution under shared/multi-tenant resources · M3 · adversarial · 5
- ▢ Golden Suites + chaos verification tier (steady-state hypothesis = SLO invariant) · M4 · slice/hardening · 5
- ▢ Reliability SLA targets ratification + status pages / ops dashboard rollup · M4 · slice/user-story · 3
- ▢ SPIKE: saga compensation correctness + CreditLedger accuracy/reconciliation · M2 · spike · 3

---

## 11. Progressive Delivery — The Harness — `122f5e0a-30d6-4949-9285-9441d18c36d9` — **complete · 24 issues**

- ▢ Define the `hobo:feature-flag` port (OpenFeature-compatible) · M0 · slice · 3
- ▢ Define the `hobo:delivery` (OpenDelivery) port + `rollout.*` events · M0 · slice · 3
- ▢ Define the `hobo:experiment` (OpenExperiment) port + `experiment.*` events · M0 · slice · 3
- ▢ Define `flag.*` events + IfC flag definitions in the Bindle · M0 · slice · 2
- ▢ Define the SLO-gate / promotion-policy contract consumed from Reliability · M0 · slice · 2
- ▢ Built-in flag store + in-process deterministic evaluation engine · M1 · slice · 5 (←#1)
- ▢ SDK flag surface: `ctx.flags.eval` (server) + `useFlag` (reactive client) · M1 · slice · 3
- ▢ Sync flag ruleset to in-process evaluator via the Streamer/event log · M1 · slice · 3
- ▢ Harness delivery-orchestrator skeleton (deploy dark → ramp flag → step) · M1 · slice · 5 (←#2)
- ▢ Provision preview/ephemeral environments (per-PR Camps, isolated streams, auto-TTL) · M1 · slice · 5
- ▢ Canary + blue/green + progressive saga templates over gateway traffic-split · M2 · slice · 8 (←#9)
- ▢ SLO-gated automatic promotion/rollback loop (Flagger-style metric analysis) · M2 · slice · 5 (←#11,#5)
- ▢ Policy-gated flag flips (prod kill-switch / risky % → approval + auto-revert) · M2 · slice/security · 3
- ▢ OpenExperiment assignment + exposure + metrics over event log + OTEL · M2 · slice · 3
- ▢ Experiment statistical-analysis surface · M2 · slice · 5
- ▢ SPIKE: SLO-gated auto-rollback decision correctness · M2 · spike · 3 (←#12)
- ▢ OpenFeature provider adapters (flagd / LaunchDarkly / Unleash) · M2 · slice · 5
- ▢ ADVERSARIAL: flag-evaluation consistency under partition/stale ruleset · M3 · adversarial · 3
- ▢ ADVERSARIAL: detect + safely converge stuck / partial rollouts · M3 · adversarial · 3
- ▢ ADVERSARIAL: experiment peeking / p-hacking / multiple-comparisons guardrails · M3 · adversarial · 3
- ▢ ADVERSARIAL: rollback that itself fails — compensation idempotency + escalation · M3 · adversarial/hardening · 5 (←#11)
- ▢ Flag-debt auto-cleanup (stale-flag detection + archival) · M4 · slice/hardening · 2
- ▢ Cross-Camp flag-state consistency (bounded staleness) · M4 · slice/hardening · 3
- ▢ Delivery + experiment adapter conformance suite (Argo/Flagger; Statsig/etc.) · M4 · slice · 3

---

## 12. Generation Pipeline, Training & AI Safety — `d19bf007-d3a6-4706-9c82-658261060fc4` — **complete · 24 issues**

- ▢ G1 — Generation-pipeline IO contract + `gen.*` event family · M0 · slice · 3
- ▢ G2 — Eval rubric + promotion-gate contract (Contract/Eval/Policy three-pass) · M0 · slice · 3 (←G1)
- ▢ G3 — SLSA-style provenance + signed-certification descriptor · M0 · slice/security · 2 (←G1)
- ▢ G4 — `training-engine` WIT port + trajectory/OpenInference capture contract · M0 · slice · 3 (←G1)
- ▢ G5 — No-egress generation-sandbox boundary contract · M0 · slice/security · 2 (←G1)
- ▢ G6 — Scaffold stage: per-artifact-kind / per-port templates · M1 · slice · 3 (←G1)
- ▢ G7 — LLM-fill stage (contract-first, sanitized hints) · M1 · slice · 5 (←G6,G3,G5)
- ▢ G8 — Validation stage: sandboxed conformance + trace-replay harness · M1 · slice · 5 (←G5,G2,G1)
- ▢ G9 — Bounded repair loop (failure-set → regenerate, budget → `gen.NeedsHuman`) · M1 · slice · 3 (←G8,G7)
- ▢ G10 — Promotion policy gate (low-risk auto-certify vs prod human hook) · M1 · slice/security · 3 (←G2,G8)
- ▢ G11 — OpenInference trajectory capture + trajectory store · M1 · slice · 3 (←G4)
- ▢ G12 — Built-in OPTO training-engine optimizer · M2 · slice · 8 (←G4,G11,G2)
- ▢ G13 — Live-evals: continuous rubric scoring on live/shadow traffic · M2 · slice · 5 (←G11,G2)
- ▢ G14 — Champion/challenger + shadow-traffic promotion with region-scoped AST persist · M2 · slice · 5 (←G12,G13,G10,G3)
- ▢ G15 — Certify stage: sign + provenance + publish to Registry · M2 · slice/security · 3 (←G3,G10,G8)
- ▢ G16 — End-to-end cold-start reference run: generate a `database` provider · M2 · slice · 5 (←G6,G7,G8,G9,G15)
- ▢ G17 — SPIKE: generation-eval methodology (rubrics, judges, golden trajectories) · M3 · spike · 3 (←G2)
- ▢ G18 — Harden material-input sanitization against prompt injection · M3 · slice/security/adversarial · 5 (←G7,G5)
- ▢ G19 — Detect conformance-passing-but-malicious/backdoored generated code · M3 · slice/security/adversarial · 5 (←G8,G5)
- ▢ G20 — Defend the training/data flywheel against trajectory poisoning · M3 · slice/security/adversarial · 5 (←G11,G12,G13)
- ▢ G21 — Enforce human-in-the-loop gates against automation bias / over-reliance · M3 · slice/security/adversarial · 3 (←G10,G14,G15)
- ▢ G22 — SPIKE: data-flywheel privacy model (capture, retention, tenant isolation) · M3 · spike/security · 3 (←G11)
- ▢ G23 — Integrate generation with self-healing live-fix (failing trace → gated candidate) · M4 · slice · 3 (←G8,G9,G10,G14)
- ▢ G24 — Verify cross-layer generated-stack propagation (one loop, five layers) · M4 · slice · 5 (←G16,G14,G23)

---

## 13. Portability, Registry & Distribution — `fd338892-6949-42ea-aca4-e1e71e3c3b05` — **complete · 22 issues**

- ▢ Define the registry artifact descriptor + listing-kind taxonomy schema · M0 · slice · 3
- ▢ Define the version + semver/compat-resolution policy for distributed artifacts · M0 · slice · 3
- ▢ SPIKE: version/compat resolution semantics (pinned vs floating, ranges, tier-aware bumps) · M0 · spike · 3
- ▢ Formalize the per-listing Capability Spec (`interface@version@stability` + conformance-suite version) · M0 · slice · 3
- ▢ Define the `hobo:artifact-repo` port contract (pull/publish, digest-pinned, mirror-set) · M0 · slice · 3
- ▢ Define the signed offline-bundle format + manifest for air-gap import · M0 · slice · 3
- ▢ Implement OCI-backed artifact storage + push/pull of registry descriptors · M1 · slice · 5
- ▢ Implement the publish flow: sign + conformance-certify + provenance → `listing.Published/Certified` · M1 · slice · 5 (←HOBO-7)
- ▢ Implement capability-indexed discovery + MCP surface (`hobo add` resolution input) · M1 · slice · 5
- ▢ Implement install-time signature + provenance + conformance verification (`hobo add`) · M1 · slice/security · 5 (←HOBO-7)
- ▢ Implement the version/compat resolver + dependency resolution over distributed artifacts · M2 · slice · 5
- ▢ Implement digest-as-selection-key + mirror cost-tiebreak (only among byte-identical digests) · M2 · slice/security · 5
- ▢ Implement the `listing.*` lifecycle + yank propagation · M2 · slice · 5
- ▢ Implement the curated-catalog (trust-tiered pre-approved listing set) + policy pin · M2 · slice · 3
- ▢ Implement `hobo registry import` (signed offline bundle → in-boundary mirror) · M2 · slice · 5
- ▢ Implement the trust-tier composite (provenance + publisher identity + ratings) + min-tier policy · M2 · slice/security · 3
- ▢ Implement the never-gate-portability swap-for-equivalent escape hatch at distribution level · M2 · slice · 3
- ▢ Wire Junction registry/signed-artifact federation · M2 · slice · 3
- ▢ ADVERSARIAL: dependency-confusion & typosquatting — digest-mismatch aborts resolve · M3 · adversarial/security · 5
- ▢ ADVERSARIAL: registry compromise + signature-verification-bypass resistance · M3 · adversarial/security · 5
- ▢ ADVERSARIAL: version pinning vs floating drift — immutable-pin & deprecation-window enforcement · M3 · adversarial · 5
- ▢ ADVERSARIAL: air-gapped/offline install integrity — offline revocation, anti-rollback, transparency-inclusion · M3 · adversarial/security · 5

---

## 14. Operators & SRE — the Crew — `036f25f3-94bf-4253-ac06-d128eaedbf49` — **complete · 22 issues**

- ▢ Author the remediation-action + blast-radius contract (the autonomous-write envelope) · M0 · slice · 5
- ▢ Author the `crew.*` event family + the Crew operator principal model · M0 · slice · 3
- ▢ Author the Incident aggregate + `incident.*` lifecycle contract · M0 · slice · 3
- ▢ Author the declarative runbook schema (trigger → diagnose → gated fix) + `runbook.*` events · M0 · slice · 3 (←#1)
- ▢ SPIKE: the autonomous-action safety-rail / blast-radius model · M0 · spike · 3
- ▢ Author the failure-taxonomy → safe-fix classifier map · M0 · slice · 3 (←#1)
- ▢ Build the SRE operator skeleton (signal → dispatch → Incident open) · M1 · slice · 3 (←#2,#3)
- ▢ Build the Endpoint Monitor operator (synthetic probes + SLO/drift surfacing → feeds SRE) · M1 · slice · 3 (←#2,#7)
- ▢ Implement the diagnose step over projections (read-only, autonomous) · M1 · slice · 3 (←#3,#7)
- ▢ Implement the SRE decision tree: classify → auto-fix / propose / escalate · M2 · slice · 5 (←#1,#6,#9)
- ▢ Wire gated autonomous remediation through the policy plane + live-fix canary/auto-rollback · M2 · slice · 5 (←#1,#10)
- ▢ Build the runbook execution engine on the Pipelines engine · M2 · slice · 5 (←#4,#11)
- ▢ Implement on-call escalation as a policy obligation with a deadline (A2H lane) · M2 · slice · 3 (←#3,#10)
- ▢ Implement autonomous drift remediation (resync vs propose, gated) · M2 · slice · 3 (←#6,#11)
- ▢ Implement the human-operator console + approval surface (MCP + dashboard) · M2 · slice/user-story · 5 (←#11,#13)
- ▢ Wire the issue-tracker + knowledge operator integration ports · M3 · slice · 3 (←#11)
- ▢ Implement chaos-experiment orchestration with blast-radius + abort gating · M3 · slice · 5 (←#5,#11)
- ▢ Implement disaster-recovery failover orchestration (replay-restore drill) · M3 · slice · 5 (←#11,#12)
- ▢ Implement MTTD/MTTR SLOs + postmortem-as-replay · M3 · slice · 3 (←#3,#11)
- ▢ ADVERSARIAL: contain runaway automated remediation (oscillation / outage amplification) · M3 · adversarial/hardening · 5 (←#5,#11,#14)
- ▢ ADVERSARIAL: block remediation on a false-positive signal + reject unauthorized/unbudgeted action · M3 · adversarial/security · 5 (←#10,#11)
- ▢ ADVERSARIAL: prevent DR failover from corrupting state (fencing + RPO/RTO integrity) · M4 · adversarial/hardening · 5 (←#18)

---

## 15. CLI, MCP & Developer Experience — `4783497d-6376-41ef-bf18-9c1fa068ade8` — **complete · 28 issues**

- ▢ Build the `hobo` CLI shell: arg parser, command registry, output renderer, MCP-parity dispatch · M1 · slice · 5 (←HOBO-8)
- ▢ `hobo new <name> [-t todo|api|agent|fullstack]`: scaffold an SDK program · M1 · slice · 3 (←HOBO-88)
- ▢ `hobo dev`: local runtime loop with hot-reload, codegen-in-watch, offline replay · M1 · slice · 8 (←HOBO-17,88)
- ▢ `hobo plan [--camp]`: DeploymentPlan + cost + warnings as an approvable diff · M2 · slice · 5 (←HOBO-67,61)
- ▢ `hobo up [--camp --strategy --to --rollback]`: provision+deploy convergence · M2 · slice · 8 (←HOBO-61,103)
- ▢ `hobo down [--camp]`: reverse-dependency teardown/deprovision · M2 · slice · 3 (←HOBO-109)
- ▢ `hobo login` (OIDC dev SVID) + `hobo claim` (bind anonymous deploy to account) · M2 · slice/security · 5 (←HOBO-71,84,90)
- ▢ `hobo inspect run|deploy|topology`: projection/time-travel read views · M2 · slice · 3
- ▢ `hobo logs [--follow] [<resource>]`: live stream over Camp runtime streams · M2 · slice · 3 (←HOBO-23)
- ▢ `hobo doctor`: env/credential/connectivity + non-portable-`.raw()` diagnostics · M2 · slice · 3
- ▢ `hobo codegen [--check]`: regen `_generated/`, CI drift gate · M1 · slice · 2 (←HOBO-88)
- ▢ `hobo build`: componentize services to wasm (jco) → OCI fallback · M2 · slice · 5
- ▢ `hobo collect [--camp]`: run resource-collection (IfC) → print manifest IR · M1 · slice · 2 (←HOBO-67)
- ▢ Anonymous `npx hobo up` zero-setup ephemeral-preview path (24h TTL, returns live URL) · M2 · slice · 5
- ▢ Build the `@hobo/mcp` server: capability-scoped tool surface over the shared CLI call path · M2 · slice · 8 (←HOBO-84)
- ▢ Wire MCP tool auth to the Identity/SVID model + per-tool capability scoping · M2 · slice/security · 5 (←HOBO-71,90)
- ▢ Publish `llms.txt` / `llms-full.txt` / `docs.json` operations manifests · M2 · slice · 2
- ▢ Build the VS Code extension: topology preview, run inspector, "explain this plan" · M3 · slice · 5
- ▢ ADVERSARIAL: harden CLI auth/credential handling (no static keys, brokered short-lived, redacted logs) · M3 · adversarial/security · 5
- ▢ ADVERSARIAL: harden `hobo dev` local↔remote fidelity drift (fidelity labels + `--fork` lane isolation) · M3 · adversarial · 5
- ▢ ADVERSARIAL: harden the MCP server against prompt-injection & over-broad agent permissions · M3 · adversarial/security · 8
- ▢ USER-STORY — App dev: idea → live app via `hobo new` → `hobo dev` → `hobo up` · M2 · user-story · 5
- ▢ USER-STORY — Platform eng: map a Camp to cloud+IaC, register providers, Matching realizes the manifest · M3 · user-story · 5
- ▢ USER-STORY — GitOps: PR-driven keyless deploy, ephemeral preview Camp, promotion-as-pointer · M3 · user-story · 5
- ▢ USER-STORY — SecOps: enforce a policy deny-ceiling & prove the credential audit on `hobo up` · M3 · user-story/security · 5
- ▢ USER-STORY — SRE: drift → governed remediation via inspect/logs + gated crew action · M4 · user-story · 5

> Optional (to reach full 6-role walkthrough coverage): DevOps self-host (`hobo up ./platform --seed`)
> and DevOps progressive-canary-rollout user stories.

---

## Coverage / completeness notes

- **All 15 subsystems are fully materialised** in Linear — **399 issues**, phased M0 Contracts →
  M1 Skeleton → M2 Core → M3 Hardening → M4 GA, with dependency (`blockedBy`) graphs wired within
  and across projects.
- Every subsystem carries **spike** slices for the genuinely uncertain decisions (e.g. wRPC/WIT
  baseline, Matching tie-break, self-host bootstrap ordering, deny-ceiling algebra, replay==live
  proof, Junction inference, generation-eval methodology, data-flywheel privacy) and
  **adversarial** slices for its top abuse/failure modes (48 adversarial issues in total).
- The **role-based user-story walkthrough** (app dev / platform eng / GitOps / SecOps / SRE,
  + DevOps×2) is captured under Project 15 (CLI/MCP/DX) as `user-story` issues that thread across
  subsystems, with cross-project `blockedBy` to the verbs and contracts they exercise.
- `HOBO-11` (ADR ↔ implementation traceability audit, Foundations) is the standing gate that
  confirms every ADR/Plan maps to ≥1 issue; with all 15 subsystems now populated, every ADR file
  (01-architecture-core, 02-identity-security, 03-data-plane, 07-portability-extensibility) and the
  design-suite features map onto at least one branch-sized slice.
- **Authoritative source:** Linear (team **HoBo**). This document is the durable structural mirror;
  for exact ids, live status, and full issue bodies, consult Linear.
