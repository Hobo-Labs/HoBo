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
| pass | 11 | 2 | 4 |
| partial | 4 | 5 | 6 |
| built-not-proven | 0 | 4 | 0 |
| not-built | 0 | 0 | 0 |
| met-differently | 2 | 2 | 0 |
| intentional-gap | 3 | 0 | 2 |

## Kargo primitive map

HoBo vocabulary is documented in `docs/competitors/kargo.md`. This table adds
**parity state** and evidence pointers.

| Kargo primitive | HoBo counterpart | State | Evidence / gap |
| --- | --- | --- | --- |
| **Warehouse** | Freight source (`@hobo/cd/sources`) | **pass** | Pull discovery, forward-only cursors, assembly; broader than Kargo (package registries, HTTP index, HoBo CI, Rails). `packages/cd/src/sources/README.md`. |
| **Freight** | Freight ledger (`@hobo/cd/freight`) + `CdFreight` (`@hobo/cd/domain`) | **pass** | Content-addressed manifest; alias; yank/retire/approve; Story BDD tests in `packages/cd/test/cd-kargo-pull-domain.test.ts`. Not CRD-compatible with Kargo. |
| **Stage** | Pipeline node (`@hobo/cd/pipelines`) + `CdStage` (`@hobo/cd/domain`) | **pass** | Camps or Placement per node; graph validation in `apply`; pull-based Stage aggregate & saga in `packages/cd/src/domain/CdStage.aggregate.ts`. |
| **requestedFreight / origin slots** | Per-node `from_sources` + `CdStage` `originSlots` (`OriginSlotId`) | **pass** | Named multi-origin slots with independent Freight state and auto-promotion holds per slot (`packages/cd/src/domain/CdStage.aggregate.ts`, `packages/cd/test/cd-kargo-pull-domain.test.ts`). |
| **Availability OneOf / All** | `ONE_OF` / `ALL` | **pass** | `packages/cd/test/pipelines/availability.test.ts` (`Kargo parity:`) and `packages/cd/test/cd-kargo-pull-domain.test.ts`. |
| **Soak** | `required_soak_ms` / `requiredSoakMs` | **pass** | Measured from upstream qualification; `packages/cd/test/pipelines/availability.test.ts` and `packages/cd/test/cd-kargo-pull-domain.test.ts`. |
| **QUORUM (fleet)** | `QUORUM` + Placement | **pass** | Beyond Kargo; documented in pipelines README and tested in `packages/cd/test/cd-kargo-pull-domain.test.ts`. |
| **Verification** | `VerificationEngine` + `CdVerificationGate` | **met-differently** | Deterministic stats + probes; no Argo Rollouts `AnalysisTemplate` / `AnalysisRun`. `packages/cd/src/verification/README.md`. |
| **Implicit Argo CD health wait** | Publisher `observe()` + `ExecuteCdDeliveryFlow` + Rivet `pullWatch` | **partial** | GitOps pull adapter and RivetKit SQLite pull-watch actor wait for PR merge and Argo sync/health with timeout alarms (`packages/cd-gitops/src/flow-adapter.ts`, `packages/cd/src/host/rivet.ts`); no live cluster sync-window attribution yet. |
| **Manual Freight approval** | `freight.Approved` / `ApproveFreightForStage` | **pass** | Policy-gated, expiring; audited in journal and `CdFreight` aggregate. |
| **Auto-promotion Newest / MatchUpstream / MatchNode** | `AUTO_PROMOTION_*` on pipeline nodes + `CdStage` | **pass** | Proto (`AUTO_PROMOTION_MATCH_NODE` et al.), controller, fan-out catch-up tests (`packages/cd/test/pipelines/`, `fanout/`), and `CdStage`. |
| **Auto-promotion holds** | `CdStage` per-slot holds (`StageAutoPromotionHoldSet` / `Cleared`) | **pass** | Manual promotion of non-candidate Freight pins the origin slot on completion, rejects `trigger: "auto"` with `AutoPromotionHeld`, ignores failed runs, and clears only on manual promotion of the latest candidate or when auto-promotion is disabled (`packages/cd/src/domain/CdStage.aggregate.ts`, `packages/cd/test/cd-kargo-pull-domain.test.ts`). |
| **Project-level auto-promotion toggle** | Per-node `auto_promotion` only | **partial** | Kargo `ProjectConfig` gates who may enable auto-promotion. HoBo uses pipeline node fields + `pipeline.apply` authz; no project-wide admin-only switch. |
| **Promotion template + steps** | Promotion saga + typed hooks + deterministic GitOps updaters | **met-differently** | Typed hooks (`RUNBOOK`, `NOTIFY`, `SUITE`) plus deterministic JSON/YAML/Kustomize updaters in `packages/cd-gitops/src/updaters.ts`; no expression runtime (ADR-0182 D4). |
| **Stage / promotion variables + `${{ }}` expressions** | — | **intentional-gap** | Kargo Stage `spec.vars` and promotion expressions. HoBo has no expression runtime (ADR-0182 D4; rejected in ADR-0182 consequences). |
| **PromotionTasks (reusable templates)** | — | **intentional-gap** | Kargo shared task CRDs. HoBo uses typed hooks + Delta saga instead. |
| **Promotion UI / graph** | `GET /v1/cd/pipelines/*` graph API | **partial** | Service tests show per-node Freight (`packages/cd/test/service/control-api.test.ts`). No first-class promotion graph UI like Kargo's. |
| **argocd-update / argocd-wait steps** | `createArgoCdPullFlowAdapter` + `observeArgoApplicationsBySelector` | **partial** | Git branch/PR creation, deterministic updaters, label-selector Argo observation, and optional sync trigger live in `packages/cd-gitops/src/flow-adapter.ts` (`packages/cd-gitops/test/pull-flow.test.ts`, 13 tests); production cluster traffic still pending P9. |
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

### Kargo gaps remaining after formalization

1. **GitOps observation depth in production**: sync-window timeouts and manual-vs-automated sync attribution against a live Argo CD cluster (P9).
2. **Promotion graph visibility** at least at CLI/MCP parity (API exists; product surface trails Kargo UI).

## Argo CD primitive map

Argo CD is a **convergence engine** under HoBo, not the promotion brain (ADR-0182
D5). Parity means: when a Camp uses publisher mode, operators get pull GitOps
behavior, rendered Applications, and observable convergence.

| Argo CD primitive | HoBo counterpart | State | Evidence / gap |
| --- | --- | --- | --- |
| **Application (source → destination)** | Rendered `argo-cd.application.json` + ConfigMap set | **built-not-proven** | `packages/cd-gitops/src/render.ts`; golden tests. Consumer PACT — not provider-verified traffic; no production publisher→Argo observation yet (P9). |
| **Sync / health status** | `observe()` + `observeArgoApplicationsBySelector` | **built-not-proven** | PACT + pull-flow unit tests (`packages/cd-gitops/test/pull-flow.test.ts`); revision must match Git commit. Same production observation gap. |
| **Pull-based GitOps** | Publisher + `createArgoCdPullFlowAdapter` | **built-not-proven** | Direct commit & PR-based pull flows verified in `packages/cd-gitops/test/pull-flow.test.ts`. Channel rule needs one linked CONVERGED observation. |
| **Flux alternative** | `createFluxPullFlowAdapter` + Flux render | **built-not-proven** | `flux.kustomization.json` path + pull-flow tests (`packages/cd-gitops/test/pull-flow.test.ts`). No linked production publisher→Flux CONVERGED observation yet. |
| **AppProject / RBAC** | `@hobo/cd/authz` + Station policy packs | **met-differently** | `authz` evaluates `@hobo/contracts` rules on the Station pack (`packages/cd/src/authz/README.md`). Not AppProject-shaped. `@hobo/policy` posture is separate (ADR-0182 D25). |
| **OutOfSync / per-resource diff UI** | Drift events + `drift.DiffProposed` + `outOfSyncResources` | **partial** | Reconciler emits drift and Argo verdict extracts `outOfSyncResources`; no live resource tree UI. |
| **ApplicationSet / matrix generators** | Placement + fan-out + label-selector observation | **partial** | Fan-out is journal-driven over Camps; no Git-rendered ApplicationSet CRD. |
| **Sync waves / hook ordering** | `renderPublication(..., { syncWave })` | **pass** | Emits `argocd.argoproj.io/sync-wave` annotations on rendered Argo CD Application and ConfigMap manifests (`packages/cd-gitops/src/render.ts`, `packages/cd-gitops/test/render.test.ts`). |
| **Automated sync policy (prune/self-heal)** | `render.ts` when `autoSync` | **pass** | When `autoSync` is set, render emits `spec.syncPolicy.automated{prune,selfHeal:true}` (`packages/cd-gitops/src/render.ts`; golden `test/golden/argo-cd.application.json.golden`). |
| **Multi-cluster hub** | `cd-kube-fleet` (OCM/Karmada) | **met-differently** | Not Argo CD hub-spoke; fleet transports differ (ADR-0182 D26). |
| **Notifications** | CDEvents + NOTIFY hooks | **partial** | Structured events; not Argo Notifications CRD integration. |
| **OCI / Helm / Kustomize sources** | Set resolution + `updaters.ts` (JSON/YAML/Kustomize) | **partial** | Deterministic updaters ship in `packages/cd-gitops/src/updaters.ts`; Argo multi-source Application spec not generated. |
| **argocd CLI / UI parity for HoBo operators** | `hobo deploy camp show`, service API | **partial** | No embedded Argo UI; deep links not standardized. |

### Argo CD integration gaps remaining

1. **`packages/cd-argocd` (proposed)** — dedicated read-only engine adapter beside `cd-gitops` if split out from `cd-gitops/src/engines/`.
2. **ApplicationSet or documented equivalent** for fleet Camps (rendered or hub policy).
3. **Drift surfacing** to CLI/API (journal-sourced diff is acceptable).
4. **Production observation** of publisher → Argo CD (CONVERGED with real revision),
   linked per AGENTS.md channel rule (P9).

## Cross-cutting scorecard

Explicit rows for engine layout and release touchpoints. State counts for this
12-row table appear in the summary table above. Optional formalization ideas
below are **not** included in those counts.

| Topic | State | Notes |
| --- | --- | --- |
| `@hobo/cd` core (journal, pipelines, promotion) | **pass** | Executable module tests + `CdRelease` Story BDD suite |
| `@hobo/cd-gitops` publisher (Argo + Flux via Git) | **partial** | Pull-flow adapter + sync waves pass unit/PACT tests; production channel unproven |
| `@hobo/cd-kube-fleet` | **pass** | OCM/Karmada; not Argo CD hub |
| `@hobo/cd-vercel` hosted runtime | **partial** | Tick schedule **and** `cd-api` (`/v1/cd/`, agent feed, probes); journal on Neon fleet |
| `@hobo/hobo-cd` CD Bindle + `hobo cd up` | **partial** | Vercel connection/lifecycle ceremony; not `@hobo/cd/compose` |
| `CdEngineRegistry` in `@hobo/cd/compose` | **pass** | `engines.ts`, `packages/cd/test/compose/engines.test.ts`, `cd-gitops` bridge (P2) + flow router in `packages/cd/src/host/flow-router.ts` |
| `@hobo/cd-argocd` native API adapter | **partial** | Read/observe PACT + RUNBOOK sync observation (P3: `@hobo/cd-argocd`) plus read/observe client in `@hobo/cd-gitops/src/engines/index.ts`; no Argo write API |
| Separate `@hobo/cd-kargo` promotion runtime | **intentional-gap** | Would duplicate `@hobo/cd` brain (ADR-0182) |
| Separate `@hobo/cd-octopus` engine | **intentional-gap** | Supported as a pluggable `release-orchestrator` target via `CdEngineRegistry` + `createCdDeliveryFlowRouterLayer` |
| Publisher registry lookup | **partial** | Unit test `createPublisherRegistry` in `packages/cd-gitops/test/publisher.test.ts` — not composition-suite wiring |
| Release → Freight coupling | **partial** | CI/CD sources and ingest; release-script coupling is parallel work |
| CD artifact provenance on ingest | **pass** | `@hobo/cd/provenance`, ingest paths (distinct from main-train npm/GHCR publish) |

### EffectTS + Alchemy Domain + Rivet formalization

| Component | Status | Evidence |
| --- | --- | --- |
| `@hobo/cd/domain` (`CdRelease` Alchemy Domain model) | **pass** | `packages/cd/src/domain/` (`CdFreight`, `CdStage`, `CdDeliveryFlow`, `CdDeliveryRun`, `ExecuteCdDeliveryFlow`, holds & multi-origin slots); neutral `@hobo/cd` core preserved (`test/boundary/neutral-core.test.ts`) |
| `@hobo/cd/host` (InMemory, SQLite, HTTP, Rivet) | **pass** | `packages/cd/src/host/` (`createCdDeliveryFlowRouterLayer`, `createCdPullWatchRegistry` SQLite actor + alarms + broadcasts, `packages/cd/test/cd-release-host.test.ts`) |
| `@hobo/cd-gitops` pull-flow Effect adapters | **pass** | `packages/cd-gitops/src/flow-adapter.ts` (`createArgoCdPullFlowLayer`, `createFluxPullFlowLayer`, `packages/cd-gitops/test/pull-flow.test.ts`) |

## Stacked PR sequence (Step 2)

Work **off `origin/main`**, one concern per PR, `agent:check -- --base=origin/main`
green before handoff. Later PRs update row states in this file when they land.

| PR | Scope | Status / closes |
| --- | --- | --- |
| **P1** | `docs/cd/*` (this audit) + index links | Landed |
| **P2** | `CdEngineRegistry` contract in `@hobo/cd/compose` + wiring tests | Landed (`engines.ts`, `cd-gitops` bridge) |
| **P3** | `packages/cd-argocd`: read/observe PACT + RUNBOOK observation hooks | Landed (`@hobo/cd-argocd`, `ARGO_CD_SYNC_RUNBOOK`, `packages/cd-argocd/test/*.test.ts`) |
| **P4** | Durable auto-promotion holds in `CdStage` (`@hobo/cd/domain`) | Landed |
| **P5** | Named multi-origin Freight slots in `CdStage` (`@hobo/cd/domain`) | Landed |
| **P6** | Argo `sync-wave` annotations in `@hobo/cd-gitops/src/render.ts` | Landed |
| **P7** | CLI/MCP promotion graph UI | Open |
| **P8** | EffectTS + Alchemy Domain + Rivet formalization (`@hobo/cd/domain`, `@hobo/cd/host`, `@hobo/cd-gitops`) | Landed (PR #32) |
| **P9** | Live production cluster observation: Git publisher → Argo CONVERGED | Open (requires live Argo CD cluster) |

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
