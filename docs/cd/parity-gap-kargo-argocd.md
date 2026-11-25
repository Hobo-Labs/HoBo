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

Tyler's target: HoBo CD reaches **functional parity** with **Kargo** (promotion
orchestration) and **pull-based GitOps** flows through **Argo CD** (and Flux as
the second engine), with **CD engines pluggable** the way `@hobo/ci` splits into
`ci-*` packages. Implementation should formalize on **Effect**, **Alchemy**
(`alchemy.run` Domains), and **Rivet** where durable workers and hosted ticks
apply, matching existing `packages/cd` domain work and ADR-0182.

This document is the **Step 1 audit**. It does not defer work: every `not-built`
or `partial` row below needs a stacked PR until green.

**Evidence base (this repo, `origin/main` at audit time):**

| Area | Where to look |
| --- | --- |
| Core CD | `packages/cd/` (`README.md`, module READMEs, `src/ports.ts`, `data-models/cd.proto`) |
| GitOps publisher | `packages/cd-gitops/` (`PublisherPort` for Argo CD + Flux) |
| Kubernetes fleet | `packages/cd-kube-fleet/` (OCM/Karmada, not Argo CD hub) |
| Hosted tick | `packages/cd-vercel/`, `packages/hobo-cd/` |
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

## Summary counts (first target: Kargo + Argo CD)

| State | Kargo-facing rows | Argo CD-facing rows | Cross-cutting (engines, UX) |
| --- | --- | --- | --- |
| pass | 14 | 4 | 2 |
| partial | 11 | 9 | 6 |
| built-not-proven | 0 | 1 | 2 |
| not-built | 12 | 8 | 9 |
| met-differently / intentional-gap | 7 | 6 | 4 |

## Kargo primitive map

HoBo vocabulary is documented in `docs/competitors/kargo.md`. This table adds
**parity state** and **next package**.

| Kargo primitive | HoBo counterpart | State | Evidence / gap |
| --- | --- | --- | --- |
| **Warehouse** | Freight source (`@hobo/cd/sources`) | **pass** | Pull discovery, forward-only cursors, assembly; broader than Kargo (package registries, HTTP index, HoBo CI, Rails). `packages/cd/src/sources/README.md`. |
| **Freight** | Freight ledger (`@hobo/cd/freight`) | **pass** | Content-addressed manifest; alias; yank/retire/approve. Not CRD-compatible with Kargo. |
| **Stage** | Pipeline node (`@hobo/cd/pipelines`) | **pass** | Camps or Placement per node; graph validation in `apply`. |
| **requestedFreight / origin slots** | Per-node `sources[]` + strategies | **partial** | Single pipeline binds one Bindle; multi-origin *slots* per stage (several Warehouses in one Stage) are not modeled as independent auto-promotion lanes. |
| **Availability OneOf / All** | `ONE_OF` / `ALL` | **pass** | `packages/cd/test/pipelines/availability.test.ts` (`Kargo parity:`). |
| **Soak** | `required_soak_ms` | **pass** | Measured from upstream `env.Promoted`. Same test file. |
| **QUORUM (fleet)** | `QUORUM` + Placement | **pass** | Beyond Kargo; documented in pipelines README. |
| **Verification** | `VerificationEngine` | **met-differently** | Deterministic stats + probes; no Argo Rollouts `AnalysisTemplate` / `AnalysisRun`. `packages/cd/src/verification/README.md`. |
| **Implicit Argo CD health wait** | Publisher `observe()` + rollout converge | **partial** | GitOps publisher waits for sync/health; no `argocd-wait` step semantics or sync-window attribution (manual vs auto). |
| **Manual Freight approval** | `freight.Approved` | **pass** | Policy-gated, expiring; audited in journal. |
| **Auto-promotion Newest / MatchUpstream** | `AUTO_PROMOTION_NEWEST` / `MATCH_UPSTREAM` | **pass** | Proto + controller + tests. |
| **Auto-promotion holds** | — | **not-built** | Kargo `status.autoPromotionHolds` when a human promotes non-candidate Freight ([Stages guide](https://docs.kargo.io/user-guide/how-to-guides/working-with-stages), 2026 docs). HoBo has supersession on promote queue, not hold-on-non-candidate. |
| **Project-level auto-promotion toggle** | Per-node `auto_promotion` only | **partial** | Kargo `ProjectConfig` gates who may enable auto-promotion. HoBo uses pipeline node fields + `pipeline.apply` authz; no project-wide admin-only switch. |
| **Promotion template + steps** | Promotion saga + typed hooks | **met-differently** | No `git-clone`, `git-commit`, `argocd-update`, OCI copy, Helm, etc. Hooks: `RUNBOOK`, `NOTIFY`, `SUITE` only (`packages/cd/src/promotion/README.md`). |
| **Stage / promotion variables + `${{ }}` expressions** | — | **not-built** | Kargo Stage `spec.vars` and promotion template expressions. HoBo has no expression runtime (intentional replay hazard in competitor capture). |
| **PromotionTasks (reusable templates)** | — | **not-built** | Kargo shared task CRDs. |
| **Promotion UI / graph** | `GET /v1/cd/pipelines/*` graph API | **partial** | Service tests show per-node Freight (`packages/cd/test/service/control-api.test.ts`). No first-class promotion graph UI like Kargo's. |
| **argocd-update / argocd-wait steps** | Git commit + publisher observe | **partial** | HoBo publisher writes Git and observes API; does not mutate `Application.operation` or label-select many apps. `packages/cd-gitops/README.md`. |
| **authorized-stage annotation** | — | **not-built** | Kargo requires `kargo.akuity.io/authorized-stage` on Applications. HoBo has no equivalent consent annotation contract. |
| **Freight timeline UI** | `GET /v1/cd/freight/{id}` | **pass** | Service test covers timeline ordering. |

### Kargo gaps that are intentional (document, do not “parity” blindly)

| Topic | HoBo choice | Reference |
| --- | --- | --- |
| Imperative promotion steps + expression language | Typed hooks + Delta saga only | `docs/competitors/kargo.md`, ADR-0182 D4 |
| AnalysisTemplate / Rollouts verification | Deterministic verification engine | `packages/cd/src/verification/` |
| Kubernetes CRD API | Journal + protobuf/CUE ports | `@hobo/cd` boundary rules (I11) |
| Git as sole write path | Journal authoritative; Git optional publisher | ADR-0182, `docs/design/continuous-delivery.md` |

### Kargo gaps that **must** close for parity

1. **Auto-promotion holds** and promote-by-origin UX (hold semantics without expression language).
2. **Multi-origin freight slots** per node (or explicit equivalent) with independent auto-promotion candidates.
3. **Argo CD promotion integration**: optional `argocd-update`/`argocd-wait` **as typed hooks or engine callbacks**, not a general step runner — sync attribution (manual vs automated) and sync-window timeouts.
4. **Promotion graph visibility** at least at CLI/MCP parity (today API exists; product surface trails Kargo UI).

## Argo CD primitive map

Argo CD is a **convergence engine** under HoBo, not the promotion brain. Parity
here means: *when a Camp uses publisher mode, operators get Argo-grade pull
GitOps behavior and observability.*

| Argo CD primitive | HoBo counterpart | State | Evidence / gap |
| --- | --- | --- | --- |
| **Application (source → destination)** | Rendered `argo-cd.application.json` + ConfigMap set | **pass** | `packages/cd-gitops/src/render.ts`; golden tests. |
| **Sync / health status** | `observe()` → CONVERGED / CONVERGING / BLOCKED | **pass** | PACT + unit tests; revision must match Git commit. |
| **Pull-based GitOps** | Publisher commits; engine pulls | **pass** | No Argo CD write API (by design). |
| **Flux alternative** | Same publisher package | **pass** | `flux.kustomization.json` path. |
| **AppProject / RBAC** | `@hobo/cd/authz` + `@hobo/policy` | **met-differently** | Not AppProject-shaped; policy packs at promote gate. |
| **OutOfSync / per-resource diff UI** | Drift events + `drift.DiffProposed` | **partial** | Reconciler emits drift; no Argo-like resource tree or live manifest diff UI. |
| **ApplicationSet / matrix generators** | Placement + fan-out | **partial** | Fan-out is journal-driven over Camps; no Git-rendered ApplicationSet CRD. |
| **Sync waves / hooks / windows** | Rollout stages + change windows | **partial** | Ordering is promotion/rollout-layer; rendered manifests do not emit Argo sync-wave annotations by default. |
| **Self-heal / automated sync policy** | Reconciler loop + optional publisher | **partial** | Conductor/agent reconcile; publisher does not configure Argo `spec.syncPolicy`. |
| **Multi-cluster hub** | `cd-kube-fleet` (OCM/Karmada) | **met-differently** | Not Argo CD hub-spoke; fleet transports differ. |
| **Notifications** | CDEvents + NOTIFY hooks | **partial** | Structured events; not Argo Notifications CRD integration. |
| **OCI / Helm / Kustomize sources** | Set resolution → ConfigMap JSON | **partial** | HoBo projects resolved sets; Argo-native multi-source Application spec not generated. |
| **argocd CLI / UI parity for HoBo operators** | `hobo deploy camp show`, service API | **partial** | No embedded Argo UI; deep links not standardized. |

### Argo CD integration gaps that **must** close for parity

1. **`packages/cd-argocd` (proposed)** — engine adapter package alongside `cd-gitops`:
   - PACT-backed **read** client (applications, sync status, operation state).
   - Optional **sync trigger** hook for promotion (narrow substitute for `argocd-update`).
   - Sync-window-aware wait with explicit timeout policy.
2. **ApplicationSet or documented equivalent** for fleet Camps (rendered or hub policy).
3. **Drift surfacing** benchmarked against Argo: per-resource diff available to CLI/API (even if journal-sourced).
4. **Production observation** of publisher → Argo CD channel (CONVERGED with real revision), linked from a follow-up PR per AGENTS.md channel rule.

## CD engine pluggability (CI parity bar)

CI pattern (`packages/ci/README.md`):

| Package | Role |
| --- | --- |
| `@hobo/ci` | Portable core |
| `@hobo/ci-gh-actions` | Engine: GitHub Actions relay |
| `@hobo/ci-vercel` | Engine: Vercel host |
| `@hobo/ci-dagger` | Engine: Dagger |
| `@hobo/ci-cf` | Engine: Cloudflare |
| `@hobo/ci-ado` | Engine: Azure Pipelines |

CD today:

| Package | Role | Engine parity state |
| --- | --- | --- |
| `@hobo/cd` | Promotion, pipelines, reconcilers, verification | **pass** (core) |
| `@hobo/cd-gitops` | `PublisherPort`: Argo CD + Flux via Git | **pass** (partial Argo feature coverage above) |
| `@hobo/cd-kube-fleet` | Multi-cluster realizers (OCM/Karmada) | **pass** (not Argo CD) |
| `@hobo/cd-vercel` | Hosted journal tick | **partial** (host only) |
| `@hobo/hobo-cd` | Composition / CLI wiring | **partial** |
| `@hobo/cd-kargo` | — | **not-built** |
| `@hobo/cd-argocd` | Native Argo API adapter (beyond Git publisher) | **not-built** |
| `@hobo/cd-octopus` | — | **not-built** (later target) |

Frozen port: `PublisherPort` in `packages/cd/src/ports.ts` (`publish` + `observe`).
Registry wiring exists in composition tests (`cd-gitops` `registry.get("argo-cd")`).
**Gap:** no documented **CD engine registry** mirroring CI's multi-package layout,
and no **Effect**-typed service boundaries for engine I/O.

### Effect, Alchemy, Rivet (formalization gap)

| Layer | Current | Target |
| --- | --- | --- |
| **Effect TS** | CD packages use async/await + `Outcome` types | Engine adapters and tick workers expose Effect services for retries, spans, and test layers (no public Effect dependency in `@hobo/cd` per ADR-0136 — engines may use Effect internally). |
| **Alchemy Domains** | `packages/iac/iac-alchemy` patterns for Rivet/KV/queue | CD control-plane workers (`cd-vercel` tick, future `cd-argocd` pollers) as Alchemy programs with Domains boundaries. |
| **Rivet** | `@alchemy.run/rivet` in repo; queue/KV proofs in `iac-alchemy` | Durable promotion queue / observation loops with fenced single-writer semantics aligned with ADR-0135 SQLite journal. |

**not-built:** CD-specific Alchemy/Rivet modules; only IaC precedents exist.

## Release delivery alignment

Main-train release scripts and CD reconcile interact at **Freight promotion**
and **realize-failed** observations. Parallel work owns
`release-freight-detail.ts` and `create-github-release.mts`.

| Concern | State | Notes |
| --- | --- | --- |
| Release produces Freight | **partial** | CI/cd boundary via sources and ingest; release script coupling under separate PR |
| npm/GHCR/Pages channels | **partial** | `packages/cd/README.md` reconcile module references release blocked reasons |
| OIDC / provenance on release artifacts | **pass** | `@hobo/cd/provenance`, `ingest` |

## Stacked PR sequence (Step 2 — none deferred)

Work **off `origin/main`**, one concern per PR, `agent:check -- --base=origin/main`
green before handoff. Suggested order:

| PR | Scope | Closes (rows above) |
| --- | --- | --- |
| **P1** | `docs/cd/*` (this audit) + index links | Baseline |
| **P2** | `CdEngineRegistry` contract in `@hobo/cd/compose` + wiring tests | Engine pluggability — **implemented** (`engines.ts`, `cd-gitops` bridge) |
| **P3** | `packages/cd-argocd`: read/observe/sync PACT, hook integration | Argo `argocd-update`/`wait` partial |
| **P4** | Pipeline: auto-promotion **holds** + promote-by-origin | Kargo holds / origin promote |
| **P5** | Pipeline: multi-origin slots per node | requestedFreight parity |
| **P6** | Publisher: optional syncPolicy / wave annotations in render | Sync waves partial |
| **P7** | CLI/MCP: promotion graph + freight timeline first-class | UI partial |
| **P8** | `cd-vercel` tick on Alchemy/Rivet + Effect shell | Formalization |
| **P9** | Production observation link: Git publisher → Argo CONVERGED | built-not-proven |

Octopus Deploy and additional engines follow the same registry pattern after P3.

## Maintenance

- When Kargo or Argo CD ship material doc changes, bump `research_date` and
  re-read the URLs in frontmatter.
- When a row moves to **pass**, cite the package test or PACT path in this file
  (same commit as the implementation PR).
- Competitor narrative stays in `docs/competitors/kargo.md` and
  `docs/competitors/argo-cd.md`; this file is the **scorecard**.

## Related

- [HoBo.CD design](../design/continuous-delivery.md)
- [ADR-0182](../design/adr/01-architecture-core.md#adr-0182)
- [GitOps runbook](../runbooks/cd/cd-gitops.md)
- [CI parity scorecard](../ci/parity-scorecard.md) (format reference)