---
type: Competitive Reference
title: "Kargo — Competitor Reference"
description: "Akuity's promotion orchestrator layered on GitOps: Warehouses discover artifacts, Freight bundles them, Stages form a promotion graph with verification-based qualification. The direct source of HoBo.CD's Freight and lineage model."
tags: [hobo, competitors]
competitor:
  slug: kargo
  name: "Kargo"
  aliases: ["akuity-kargo"]
  primary_category: delivery-release-gitops
  categories: [delivery-release-gitops]
  directness: overlapping
  role: "the promotion-lineage reference HoBo.CD's Freight, Freight sources and pipeline graph are modelled on, without its Kubernetes CRDs or Git-only write path"
  posture: [borrow, benchmark]
  hobo_surface: [delivery, environments, reconciliation]
  evidence: implemented
  status: active
  research_date: 2026-11-11
  sources:
    - https://docs.kargo.io/user-guide/how-to-guides/working-with-warehouses
    - https://main.docs.kargo.io/user-guide/how-to-guides/working-with-stages
    - https://docs.kargo.io/user-guide/how-to-guides/verification
    - https://docs.kargo.io/release-notes/v1.8.0
---

# Kargo — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-11-11**, read for [plan 0024](../plans/0024-hobo-cd-swarm-instruction.md)
> (HoBo.CD). Read alongside the [Argo CD](argo-cd.md) and [Flux CD](flux-cd.md) captures,
> which Kargo sits on top of, and [Harness](harness.md) for the verification model HoBo.CD
> combines with it.

## What it is

Kargo is a **promotion orchestrator for GitOps**, from Akuity. Argo CD and Flux converge a
cluster on what Git says; Kargo decides *what Git should say next* for each environment.

- **Product boundary.** It discovers new artifacts, packages them into promotable units, and
  moves those units through a graph of environments by writing to Git (or by other promotion
  steps), with verification deciding what may move on. It does not build artifacts and it relies
  on a GitOps engine to converge clusters.
- **Operating model.** Open source, Kubernetes-native (its API is a set of CRDs), with a hosted
  offering from Akuity.
- **The differentiator is lineage.** A version reaches production only after it has been verified
  in the environments upstream of it, and the system can say which upstream verification let it
  through.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Warehouse** | Subscribes to image repositories, Git repositories and Helm charts, and discovers new versions |
| **Freight** | An immutable bundle of artifact references produced by a Warehouse; the unit that is promoted |
| **Stage** | A promotion target (an environment), fed by Warehouses or by upstream Stages |
| **Promotion** | Moving one Freight into one Stage, by a sequence of promotion steps |
| **Verification** | Analysis run after a promotion; a passing verification qualifies the Freight in that Stage |
| **Availability** | Whether downstream Stages need the Freight qualified in one upstream Stage or all of them, optionally after a soak time |
| **Auto-promotion** | Policies that promote the newest Freight, or match what upstream has |
| **Manual approval** | An explicit approval that lets Freight skip qualification for one Stage |

The mental model is **a pipeline of environments where each edge is earned**: Freight moves
forward only on evidence.

## Feature surface

- Warehouse subscriptions to image, Git and Helm sources, with tag and semver selection and
  discovery limits.
- Freight as a content-identified bundle with a human-friendly alias.
- A Stage graph with `OneOf`/`All` availability from upstream and a required soak time.
- Auto-promotion policies per Stage, and a per-Stage queue where newer Freight supersedes older.
- Promotion steps (Git clone, update, commit, open a pull request, Argo CD sync, and more) with an
  expression language for parameters.
- Verification via Argo Rollouts analysis templates.
- Manual approval of Freight for a Stage, for hotfixes.
- A UI that renders the promotion graph and which Freight is where.

## Architecture

- A Kubernetes controller reconciles Warehouse, Freight, Stage and Promotion CRDs in a management
  cluster.
- Promotion writes to Git (or calls the target directly through a step); the GitOps engine in each
  target cluster converges.
- Verification runs as Argo Rollouts `AnalysisRun`s, so its metric providers are Rollouts'.
- State is the CRDs; history is their status plus Git.

## How it competes with HoBo

Kargo competes with HoBo.CD on the promotion half of delivery: how a version is discovered,
packaged, and moved between environments under evidence.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | **The real overlap.** Freight, lineage, soak, auto-promotion and supersession are the same ideas in both. |
| `environments` | Kargo Stages vs HoBo Camps as pipeline nodes; HoBo nodes can also be fleets selected by Placement. |
| `reconciliation` | Kargo delegates convergence to a GitOps engine; HoBo.CD has its own fenced per-Camp reconcilers and can also publish to Argo CD or Flux. |

## Primitive mapping

| Kargo | HoBo.CD | Honest correspondence |
| ----- | ------- | --------------------- |
| Warehouse | Freight source | **Close.** Both discover by pull, forward-only. HoBo adds package registries, HTTP indexes, HoBo CI and Rail sources, and assembly rules across subscriptions. |
| Freight | Freight | **Same name, same role**, deliberately. HoBo Freight is content-addressed over a canonical manifest that includes the Bindle declaration, so a config-only change is new Freight. |
| Stage | Pipeline node | Close. A HoBo node names Camps or a Placement. |
| Verification | `VerificationSpec`, `freight.Qualified` | Close in role. HoBo's verification is deterministic (thresholds and Mann–Whitney U) and fails on no data. |
| Availability `OneOf`/`All` + soak | `ONE_OF`/`ALL`/`QUORUM` + `required_soak_ms` | Same, plus quorum for placed nodes. |
| Auto-promotion | `NEWEST`, `MATCH_UPSTREAM`, `MATCH_NODE` | Same. |
| Manual approval | `freight.Approved` | Same, but audited, policy-gated and expiring. |
| Promotion steps | Typed hooks (`RUNBOOK`, `NOTIFY`, `SUITE`) | **Different on purpose.** HoBo has no step runner or expression language. |
| — | Delta through Gatekeeper, change windows | Kargo has no policy gate or freeze model of its own. |

## Where Kargo is stronger

- **Maturity and UI.** Kargo's promotion graph view is a working, used product; HoBo.CD exposes
  the graph through its CLI, API and projections first.
- **GitOps-native write path.** Teams that want every promotion to be a reviewable Git commit or
  pull request get that by default.
- **Ecosystem fit.** It drops into an existing Argo CD estate with little else to change.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **No Kubernetes or Git premise** (*implemented*, `@hobo/cd`). Freight sources poll registries
  and Git hosts directly; delivery targets are any platform through reconcilers and resolver
  components. A GitOps engine is an optional publisher target.
- **Policy gate on every promotion** (*implemented*). Each promotion is a Delta through the
  Gatekeeper, with change windows, Trails sequencing for data changes, and rollback as a Delta.
- **Deterministic verification** (*implemented*). Fixed statistics instead of a pluggable analysis
  runtime; no data is a failure.
- **Fleets** (*implemented*). A node can target a deterministic Placement and fan out by group
  under a failure budget, with governed failover.
- **No expression language** (*intentional*). Typed hooks only, for replay and determinism.

## Adversarial critique

- **CRDs as the API** tie promotion to a management cluster and to Kubernetes RBAC.
- **Promotion steps are a small imperative engine** with an expression language; HoBo's plan
  rejected both as a second step runner and a replay hazard.
- **Verification inherits Argo Rollouts** and its providers, so the evidence model is not Kargo's
  own.
- **Git as the default write target** makes promotion latency and conflict behavior Git's.

## Better-together / integration posture

- **Borrow** (done): Freight, Warehouse → Freight source, availability, soak, auto-promotion,
  supersession and expiring approvals are taken into HoBo.CD ([ADR-0180](../design/adr/01-architecture-core.md#adr-0180)).
- **Benchmark** on promotion-graph presentation.
- Coexistence: a HoBo.CD `publisher` reconciler can write to the same GitOps repositories an
  existing Kargo estate uses, but two promotion engines over one environment would fight; pick one
  per environment.

## Threats and lessons

1. **Lineage is the feature people adopt Kargo for.** HoBo.CD has it; it must be visible, not
   just enforced.
2. **"Freight" as a term is now shared.** HoBo kept it because it fits the rail vocabulary; docs
   must not imply compatibility with Kargo's CRDs.
3. **Imperative steps creep back.** Every promotion tool grows a step runner; HoBo's typed hooks
   need to cover real needs or users will ask for scripts.

## Sources

- [Working with Warehouses](https://docs.kargo.io/user-guide/how-to-guides/working-with-warehouses) — subscriptions, discovery, Freight
- [Working with Stages](https://main.docs.kargo.io/user-guide/how-to-guides/working-with-stages) — Stage graph, availability, soak, auto-promotion
- [Verification](https://docs.kargo.io/user-guide/how-to-guides/verification) — analysis-based qualification
- [v1.8.0 release notes](https://docs.kargo.io/release-notes/v1.8.0)
- HoBo side: [continuous-delivery.md](../design/continuous-delivery.md), [plan 0024 §I.2](../plans/0024-hobo-cd-swarm-instruction.md)

Install base, pricing of the hosted offering and the full promotion-step catalog were not verified
in this pass and are not asserted.
