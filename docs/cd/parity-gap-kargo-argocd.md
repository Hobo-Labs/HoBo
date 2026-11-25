---
type: Reference
title: "HoBo.CD parity gap: Kargo and Argo CD"
description: "Audit of packages/cd and CD adapters against Kargo (stages, freight, warehouses, promotion, verification) and Argo CD GitOps convergence; maps gaps to stacked implementation PRs and pluggable cd-* engines."
tags: [hobo, cd, delivery, kargo, argocd, parity]
status: Active
research_date: 2026-11-25
sources:
  - https://docs.kargo.io/user-guide/how-to-guides/working-with-warehouses
  - https://docs.kargo.io/user-guide/how-to-guides/working-with-stages
  - https://docs.kargo.io/user-guide/how-to-guides/working-with-freight
  - https://docs.kargo.io/user-guide/how-to-guides/verification
  - https://docs.kargo.io/user-guide/how-to-guides/argo-cd-integration
  - https://docs.kargo.io/user-guide/reference-docs/promotion-steps
  - https://argo-cd.readthedocs.io/en/stable/
  - https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/
---

# HoBo.CD parity gap: Kargo and Argo CD

**Parity goal (proposal).** Borrow Kargo-grade promotion orchestration and
Argo/Flux-style pull GitOps **without** their CRDs, APIs, or runtimes, per
[ADR-0182](../design/adr/01-architecture-core.md#adr-0182) (*the best of Kargo,
Harness, Karmada and OCM without their APIs or runtimes*). Split optional
targets across `cd-*` packages the way `@hobo/ci` splits into `ci-*` engines.

This document is the **Step 1 audit baseline**. Rows marked **not-built** or
**partial** are backlog until a stacked PR closes them. Rows marked
**intentional-gap** or **met-differently** are not backlog unless product
reverses the ADR or competitor capture.

**Evidence base (this repo, `origin/main` at audit time):**

| Area | Where to look |
| --- | --- |
| Core CD | `packages/cd/` (`README.md`, module READMEs, `src/ports.ts`, `data-models/cd.proto`) |
| GitOps publisher | `packages/cd-gitops/` (`PublisherPort` for Argo CD + Flux) |
| Kubernetes fleet | `packages/cd-kube-fleet/` (OCM/Karmada, not Argo CD hub) |
| Hosted tick + CD API | `packages/cd-vercel/`, `packages/hobo-cd/` |
| CLI composition | `packages/cd/src/compose/` (`@hobo/cd/compose`; `hobo serve cd`, engine wiring) |
| Prior mapping | `docs/competitors/kargo.md`, `docs/competitors/argo-cd.md`, `docs/design/continuous-delivery.md` |
| Kargo-named tests | `packages/cd/test/pipelines/*.test.ts` (`Kargo parity:` cases) |

**Out of scope for this audit diff:** `packages/cd/src/reconcile/release-freight-detail.ts`
and `scripts/ci/create-github-release.mts` (parallel release fix).

## State legend

| State | Meaning |
| --- | --- |
| **pass** | Behavior exists with executable proof (unit/contract/PACT) in-tree |
| **partial** | Core logic exists; operator surface, engine adapter, or production observation missing |
| **built-not-proven** | Code and tests exist; no linked production channel observation per AGENTS.md |
| **not-built** | No implementation meeting the bar |
| **met-differently** | Requirement met another way by design (ADR-0182 / competitor capture) |
| **intentional-gap** | Conscious divergence from Kargo/Argo; not a backlog item unless product reverses |

## Summary counts

Counts are derived only from the numbered scorecard tables in the next sections
(not estimates). The three optional formalization **not-built** rows under
§ Cross-cutting scorecard are **excluded** from the cross-cutting column here;
they are scoped separately in that subsection.

| State | Kargo primitive map (§) | Argo CD primitive map (§) | Cross-cutting scorecard (§) |
| --- | --- | --- | --- |
| pass | 9 | 1 | 4 |
| partial | 5 | 6 | 5 |
| built-not-proven | 0 | 4 | 0 |
| not-built | 1 | 0 | 1 |
| met-differently | 2 | 2 | 0 |
| intentional-gap | 3 | 0 | 2 |

## Kargo primitive map

HoBo vocabulary is documented in `docs/competitors/kargo.md`. This table adds
**parity state** and evidence pointers.

| Kargo primitive | HoBo counterpart | State | Evidence / gap |
| --- | --- | --- | --- |
| **Warehouse** | Freight source (`@hobo/cd/sources`) | **pass** | Pull discovery, forward-only cursors, assembly; broader than Kargo (package registries, HTTP index, HoBo CI, Rails). `packages/cd/src/sources/README.md`. |
| **Freight** | Freight ledger (`@hobo/cd/freight`) | **pass** | Content-addressed manifest; alias; yank/retire/approve. Not CRD-compatible with Kargo. |
| **Stage** | Pipeline node (`@hobo/cd/pipelines`) | **pass** | Camps or Placement per node; graph validation in `apply`. |
| **requestedFreight / origin slots** | Per-node `from_sources` (+ source subscriptions) | **partial** | Nodes admit Freight via `from_sources` (`cd.proto`). A Freight **source** already assembles multiple subscriptions (`INDEPENDENT` / `SAME_VERSION` in `sources/README.md`). Gap: Kargo-style **named origin slots** with independent auto-promotion candidates per slot. |
| **Availability OneOf / All** | `ONE_OF` / `ALL` | **pass** | `packages/cd/test/pipelines/availability.test.ts` (`Kargo parity:`). |
| **Soak** | `required_soak_ms` | **pass** | Measured from upstream `env.Promoted`. Same test file. |
| **QUORUM (fleet)** | `QUORUM` + Placement | **pass** | Beyond Kargo; documented in pipelines README. |
| **Verification** | `VerificationEngine` | **met-differently** | Deterministic stats + probes; no Argo Rollouts `AnalysisTemplate` / `AnalysisRun`. `packages/cd/src/verification/README.md`. |
| **Implicit Argo CD health wait** | Publisher `observe()` + rollout converge | **partial** | GitOps publisher waits for sync/health; no Kargo `argocd-wait` step semantics or sync-window attribution (manual vs auto). |
| **Manual Freight approval** | `freight.Approved` | **pass** | Policy-gated, expiring; audited in journal. |
| **Auto-promotion Newest / MatchUpstream / MatchNode** | `AUTO_PROMOTION_*` on pipeline nodes | **pass** | Proto (`AUTO_PROMOTION_MATCH_NODE` et al.), controller, fan-out catch-up tests (`packages/cd/test/pipelines/`, `fanout/`). |
| **Auto-promotion holds** | — | **not-built** | Kargo sets hold keys on Stages and blocks auto-promotion while a manual promotion for **non-candidate** Freight is in flight (until cleared or timed out). HoBo `PipelineController` has no hold key / tick-skip path yet (`packages/cd/src/pipelines/controller.ts`; P4). |
| **Project-level auto-promotion toggle** | Per-node `auto_promotion` only | **partial** | Kargo `ProjectConfig` gates who may enable auto-promotion. HoBo uses pipeline node fields + `pipeline.apply` authz; no project-wide admin-only switch. |
| **Promotion template + steps** | Promotion saga + typed hooks | **met-differently** | No `git-clone`, `git-commit`, `argocd-update`, OCI copy, Helm, etc. Hooks: `RUNBOOK`, `NOTIFY`, `SUITE` only (ADR-0182 D4; `packages/cd/src/promotion/README.md`). |
| **Stage / promotion variables + `${{ }}` expressions** | — | **intentional-gap** | Kargo Stage `spec.vars` and promotion expressions. HoBo has no expression runtime (ADR-0182 D4; rejected in ADR-0182 consequences). |
| **PromotionTasks (reusable templates)** | — | **intentional-gap** | Kargo shared task CRDs. HoBo uses typed hooks + Delta saga instead. |
| **Promotion UI / graph** | `GET /v1/cd/pipelines/*` graph API | **partial** | Service tests show per-node Freight (`packages/cd/test/service/control-api.test.ts`). No first-class promotion graph UI like Kargo's. |
| **argocd-update / argocd-wait steps** | Git commit + publisher `observe()` | **partial** | Promotion ends in Git publish and **read-only** observation (`PublisherPort`); HoBo never calls Argo's write API (`packages/cd-gitops/README.md`). Does not mirror imperative `Application.operation` updates or multi-app label selection. |
| **authorized-stage annotation** | Delivery authz at promote gate | **intentional-gap** | Kargo requires `kargo.akuity.io/authorized-stage` on Applications. HoBo authorizes `CdAction`s via `@hobo/cd/authz` and policy packs, not Application annotations. |
| **Freight timeline UI** | `GET /v1/cd/freight/{id}` | **pass** | Service test covers timeline ordering. |

### Kargo gaps that are intentional (document, do not “parity” blindly)

| Topic | HoBo choice | Reference |
| --- | --- | --- |
| Imperative promotion steps + expression language | Typed hooks + Delta saga only | `docs/competitors/kargo.md`, ADR-0182 D4 |
| AnalysisTemplate / Rollouts verification | Deterministic verification engine | `packages/cd/src/verification/` |
| Kubernetes CRD API | Journal + protobuf/CUE ports | `@hobo/cd` boundary rules (I11) |
| Git as sole write path | Journal authoritative; Git optional publisher | ADR-0182 D5, `docs/design/continuous-delivery.md` |
| Second promotion brain (Kargo/Octopus runtime) | Single `@hobo/cd` journal | ADR-0182 D4, `docs/competitors/kargo.md` |

### Kargo gaps that **must** close for operator parity

These stay within ADR-0182 (typed hooks, pull GitOps, no expression runtime):

1. **Auto-promotion holds** and promote-by-origin UX (hold semantics without expression language).
2. **Multi-origin freight slots** per node (or an equivalent) with independent auto-promotion candidates.
3. **GitOps observation depth**: sync-window timeouts and manual-vs-automated sync attribution in `observe()` results (not a new `argocd-update` hook kind — D4 hook set is closed until amended).
4. **Promotion graph visibility** at least at CLI/MCP parity (API exists; product surface trails Kargo UI).

## Argo CD primitive map

Argo CD is a **convergence engine** under HoBo, not the promotion brain (ADR-0182
D5). Parity means: when a Camp uses publisher mode, operators get pull GitOps
behavior, rendered Applications, and observable convergence.

| Argo CD primitive | HoBo counterpart | State | Evidence / gap |
| --- | --- | --- | --- |
| **Application (source → destination)** | Rendered `argo-cd.application.json` + ConfigMap set | **built-not-proven** | `packages/cd-gitops/src/render.ts`; golden tests. Consumer PACT — not provider-verified traffic; no production publisher→Argo observation yet (P9). |
| **Sync / health status** | `observe()` → CONVERGED / CONVERGING / BLOCKED | **built-not-proven** | PACT + unit tests; revision must match Git commit. Same production observation gap. |
| **Pull-based GitOps** | Publisher commits; engine pulls | **built-not-proven** | No Argo CD write API (by design). Channel rule needs one linked CONVERGED observation. |
| **Flux alternative** | Same publisher package | **built-not-proven** | `flux.kustomization.json` path; same consumer PACT / golden proof as Argo (`packages/cd-gitops/README.md` Proof). No linked production publisher→Flux CONVERGED observation (P9 is Argo-only today). |
| **AppProject / RBAC** | `@hobo/cd/authz` + Station policy packs | **met-differently** | `authz` evaluates `@hobo/contracts` rules on the Station pack (`packages/cd/src/authz/README.md`). Not AppProject-shaped. `@hobo/policy` posture is separate (ADR-0182 D25). |
| **OutOfSync / per-resource diff UI** | Drift events + `drift.DiffProposed` | **partial** | Reconciler emits drift; no Argo-like resource tree or live manifest diff UI. |
| **ApplicationSet / matrix generators** | Placement + fan-out | **partial** | Fan-out is journal-driven over Camps; no Git-rendered ApplicationSet CRD. |
| **Sync waves / hook ordering** | Rollout stages + change windows | **partial** | Promotion/rollout layer orders work; rendered manifests do **not** emit Argo `argocd.argoproj.io/sync-wave` annotations by default. |
| **Automated sync policy (prune/self-heal)** | `render.ts` when `autoSync` | **pass** | When `autoSync` is set, render emits `spec.syncPolicy.automated{prune,selfHeal:true}` (`packages/cd-gitops/src/render.ts`; golden `test/golden/argo-cd.application.json.golden`). |
| **Multi-cluster hub** | `cd-kube-fleet` (OCM/Karmada) | **met-differently** | Not Argo CD hub-spoke; fleet transports differ (ADR-0182 D26). |
| **Notifications** | CDEvents + NOTIFY hooks | **partial** | Structured events; not Argo Notifications CRD integration. |
| **OCI / Helm / Kustomize sources** | Set resolution → ConfigMap JSON | **partial** | HoBo projects resolved sets; Argo-native multi-source Application spec not generated. |
| **argocd CLI / UI parity for HoBo operators** | `hobo deploy camp show`, service API | **partial** | No embedded Argo UI; deep links not standardized. |

### Argo CD integration gaps that **must** close

Frozen `PublisherPort` (`publish` + `observe` only; `packages/cd/README.md`,
`packages/cd/src/ports.ts`) and ADR-0182 D4/D5 forbid adding Argo write APIs or
new hook kinds without an **ADR-0182 amendment**.

1. **`packages/cd-argocd` (proposed)** — read-only engine adapter beside `cd-gitops`:
   PACT-backed **read** client (applications, sync status, operation state) and
   RUNBOOK hooks that **observe** sync (not `Application.operation` writes).
2. **Sync-wave annotations** in publisher render (P6) — ordering gap only; syncPolicy
   automated path already ships when `autoSync`.
3. **ApplicationSet or documented equivalent** for fleet Camps (rendered or hub policy).
4. **Drift surfacing** to CLI/API (journal-sourced diff is acceptable).
5. **Production observation** of publisher → Argo CD (CONVERGED with real revision),
   linked per AGENTS.md channel rule (P9).

## Cross-cutting scorecard

Explicit rows for engine layout and release touchpoints. State counts for this
12-row table appear in the summary table above. Optional formalization ideas
below are **not** included in those counts.

| Topic | State | Notes |
| --- | --- | --- |
| `@hobo/cd` core (journal, pipelines, promotion) | **pass** | Executable module tests |
| `@hobo/cd-gitops` publisher (Argo + Flux via Git) | **partial** | Feature rows in Argo map; production channel unproven |
| `@hobo/cd-kube-fleet` | **pass** | OCM/Karmada; not Argo CD hub |
| `@hobo/cd-vercel` hosted runtime | **partial** | Tick schedule **and** `cd-api` (`/v1/cd/`, agent feed, probes); journal on Neon fleet |
| `@hobo/hobo-cd` CD Bindle + `hobo cd up` | **partial** | Vercel connection/lifecycle ceremony; not `@hobo/cd/compose` |
| `CdEngineRegistry` in `@hobo/cd/compose` | **pass** | `engines.ts`, `packages/cd/test/compose/engines.test.ts`, `cd-gitops` bridge (P2) |
| `@hobo/cd-argocd` native API adapter | **not-built** | Beyond Git publisher (P3) |
| Separate `@hobo/cd-kargo` promotion runtime | **intentional-gap** | Would duplicate `@hobo/cd` brain (ADR-0182) |
| Separate `@hobo/cd-octopus` engine | **intentional-gap** | Later optional target; same registry pattern only |
| Publisher registry lookup | **partial** | Unit test `createPublisherRegistry` in `packages/cd-gitops/test/publisher.test.ts` — not composition-suite wiring |
| Release → Freight coupling | **partial** | CI/CD sources and ingest; release-script coupling is parallel work |
| CD artifact provenance on ingest | **pass** | `@hobo/cd/provenance`, ingest paths (distinct from main-train npm/GHCR publish) |

### Optional formalization (not ADR-0182; not backlog unless accepted)

ADR-0182 and `continuous-delivery.md` do not require Effect, Alchemy, or Rivet.
ADR-0136 forbids **public** Effect-TS dependencies repo-wide. ADR-0182 D16 keeps
the promotion journal on SQLite/Postgres EventStore ports, not a parallel Rivet queue.

| Idea | Status | Constraint |
| --- | --- | --- |
| Effect inside `cd-*` engine packages only | **not-built** | Must not leak into `@hobo/cd` public API (ADR-0136) |
| Alchemy workers for hosted tick | **not-built** | Precedent in `packages/iac/iac-alchemy` (isolation domains — not a “Domains” product noun) |
| Rivet for observation loops | **not-built** | Cannot replace journal single-writer authority (ADR-0182 D16 / ADR-0135) |

## Stacked PR sequence (Step 2)

Work **off `origin/main`**, one concern per PR, `agent:check -- --base=origin/main`
green before handoff. Later PRs update row states in this file when they land.

| PR | Scope | Closes (rows above) |
| --- | --- | --- |
| **P1** | `docs/cd/*` (this audit) + index links | Baseline |
| **P2** | `CdEngineRegistry` contract in `@hobo/cd/compose` + wiring tests | Cross-cutting: `CdEngineRegistry` — **implemented** (`engines.ts`, `cd-gitops` bridge) |
| **P3** | `packages/cd-argocd`: read/observe PACT + RUNBOOK observation hooks | Argo read adapter; partial `argocd-wait` semantics |
| **P4** | Pipeline: auto-promotion **holds** + promote-by-origin | Kargo holds row |
| **P5** | Pipeline: multi-origin slots per node | `requestedFreight` / origin slots row |
| **P6** | Publisher: Argo **sync-wave** annotations in render | Sync waves partial row (syncPolicy already in render when `autoSync`) |
| **P7** | CLI/MCP: promotion graph + freight timeline first-class | Promotion UI partial |
| **P8** | Hosted tick hardening (`cd-vercel` / compose) if needed | Optional formalization row — only if product accepts |
| **P9** | Production observation link: Git publisher → Argo CONVERGED | built-not-proven Argo (+ Flux publisher) channel rows |

Additional engines (e.g. Octopus) follow the same registry pattern only if product
rejects the **intentional-gap** on a second promotion brain.

## Maintenance

- When Kargo or Argo CD ship material doc changes, bump `research_date` and
  re-read the URLs in frontmatter.
- When a row moves to **pass** or **built-not-proven**, cite the package test,
  PACT path, or production observation link in the same commit as the implementation PR.
- Recalculate the summary table when any scorecard row changes state.
- Competitor narrative stays in `docs/competitors/kargo.md` and
  `docs/competitors/argo-cd.md`; this file is the **scorecard**.

## Related

- [HoBo.CD design](../design/continuous-delivery.md)
- [ADR-0182](../design/adr/01-architecture-core.md#adr-0182)
- [GitOps runbook](../runbooks/cd/cd-gitops.md)
- [CI parity scorecard](../ci/parity-scorecard.md) (format reference)
