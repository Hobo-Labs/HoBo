---
type: Competitive Reference
title: "Karmada — Competitor Reference"
description: "CNCF-graduated multi-cluster Kubernetes orchestration: propagation and override policies, spread constraints, cluster taints, failover and rebalancing. The source of HoBo.CD's spread, taint, purge and retained-field semantics, and an optional transport for Kubernetes Camps."
tags: [hobo, competitors]
competitor:
  slug: karmada
  name: "Karmada"
  aliases: ["kubernetes-armada"]
  primary_category: hybrid-multicloud-enterprise
  categories: [hybrid-multicloud-enterprise, delivery-release-gitops]
  directness: overlapping
  role: "the multi-cluster placement and failover reference HoBo.CD borrows spread, taints, graceful purge and retained fields from, and an optional single-member transport for Kubernetes Camps"
  posture: [borrow, integrate, benchmark]
  hobo_surface: [provider-matching, delivery, reconciliation, environments]
  evidence: implemented
  status: active
  research_date: 2026-11-11
  sources:
    - https://karmada.website.cncfstack.com/docs/userguide/failover/failover-analysis
    - https://karmada.website.cncfstack.com/docs/userguide/failover/cluster-taint-management
    - https://karmada.website.cncfstack.com/docs/userguide/scheduling/workload-rebalancer
    - https://karmada.website.cncfstack.com/docs/userguide/clustermanager/cluster-registration
---

# Karmada — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-11-11**, read for plan 0024
> (HoBo.CD). Read alongside [Open Cluster Management](open-cluster-management.md), the other
> multi-cluster reference, and [Kubernetes](kubernetes.md).

## What it is

Karmada ("Kubernetes Armada") is a **multi-cluster orchestrator for Kubernetes**: a control
plane that exposes the Kubernetes API, accepts ordinary resource templates, and propagates them to
member clusters according to policy. It graduated in the CNCF in September 2026.

- **Product boundary.** Placement, propagation, per-cluster overrides, failover and rebalancing
  of Kubernetes resources across clusters. It does not build or promote versions; it distributes
  whatever template it is given.
- **Operating model.** Open source, self-hosted control plane, push or pull cluster registration.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Resource template** | An ordinary Kubernetes object applied to the Karmada API server |
| **PropagationPolicy** | Selects templates and decides which member clusters receive them (affinity, spread constraints, replica scheduling) |
| **OverridePolicy** | Per-cluster changes to a template (JSON patch, image and argument overriders) |
| **ResourceBinding** | The scheduler's decision for one template, and the status rolled up from members |
| **Cluster taints and tolerations** | Marks that repel scheduling (`NoSchedule`) or evict workloads (`NoExecute`) |
| **Failover** | Cluster and application failover with purge modes and graceful eviction |
| **WorkloadRebalancer** | An explicit request to re-schedule workloads |
| **FederatedResourceQuota** | Aggregate quota across clusters |
| **Resource interpreter** | Lua or webhook customization for how a resource's replicas and status are read |

## Feature surface

- Propagation with cluster affinity, spread constraints over cluster, region, zone and provider,
  and duplicated or divided replica scheduling.
- Overrides per cluster, including image registry rewriting.
- Cluster taint management and failover, with purge modes and graceful eviction.
- Application-level failover with state preservation.
- Explicit rebalancing and a descheduler.
- Push- and pull-mode cluster registration.

## Architecture

- A Karmada API server, scheduler and controllers run in a host cluster.
- Push mode: the control plane talks to member API servers. Pull mode: an agent in each member
  pulls work.
- Status is aggregated from members onto ResourceBindings.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `provider-matching` | Karmada's PropagationPolicy chooses clusters; HoBo.CD's Placement chooses Camps, and Matching chooses providers within a Yard. |
| `delivery` | Karmada propagates and fails over; HoBo.CD promotes, verifies, fans out and fails over as governed sagas. |
| `reconciliation` | Status aggregation across members vs per-Camp reconcilers reporting observations. |
| `environments` | Member clusters vs Camps, which need not be Kubernetes. |

## Primitive mapping

| Karmada | HoBo.CD | Honest correspondence |
| ------- | ------- | --------------------- |
| Spread constraints | Placement spread | **Extended:** HoBo also spreads over `yard`, `provider`, `jurisdiction` and Camp labels. |
| Cluster taints `NoSchedule`/`NoExecute` | Camp taints `NO_PLACE`/`NO_RUN` | Close. `NO_RUN` is never added automatically from one signal (Karmada itself stopped automatic `NoExecute` in v1.14). |
| Purge modes, graceful eviction | `PurgeMode` (`GRACEFUL` default) | Close. GRACEFUL purges only after the replacement qualifies. |
| State preservation | Declared `handover_outputs` | Close. |
| `Retain` | Retained fields | Close. |
| WorkloadRebalancer | `rebalance` | Same: explicit only. |
| FederatedResourceQuota | Aggregate fan-out check against Rail and Station budget | Intent only; no new quota system. |
| OverridePolicy | Camp topology and `topology` Deltas | **Rejected:** no JSON patch or tag rewriting; the effective state must equal what was recorded. |
| Divided replicas, dynamic weights, descheduler | — | **Rejected:** most HoBo platforms have no replicas; no background rescheduling. |
| Resource interpreter (Lua/webhook) | — | **Rejected:** no scripting in status interpretation. |

## Where Karmada is stronger

- **Kubernetes-native depth.** Replica arithmetic, per-resource interpretation and the full
  Kubernetes API surface across clusters.
- **Operational track record** on large Kubernetes fleets, and CNCF graduation.
- **Overrides** make per-cluster variation easy, at the cost HoBo rejects.

## Where HoBo is stronger or intentionally different

- **Not Kubernetes-only** (*implemented*). Camps are any platform; Kubernetes is one transport.
- **Placement is pure and replayable** (*implemented*). Recorded inventory and score digests
  reproduce the decision in any input order.
- **Residency is fail-closed against declared regions** (*implemented*). Self-reported claims
  only narrow placement.
- **Failover is governed** (*implemented*). Off unless a Rail allows it, one at a time by default,
  compute only (`failover-unsafe` when data would move), and no automatic failback.
- **Verification before cutover** (*implemented*). A replacement must PASS before traffic moves.

## Adversarial critique

- **OverridePolicy makes the effective state differ from the recorded one**, which breaks
  "promote, never rebuild" and complicates audit.
- **Automatic eviction from cluster signals** was risky enough that Karmada disabled automatic
  `NoExecute`.
- **Push-mode credential rotation** failed silently for a time; HoBo makes credential validity a
  visible Camp condition for that reason.
- **Lua interpreters** put untyped code on the status path.

## Better-together / integration posture

- **Integrate** (*implemented* in `@hobo/cd-kube-fleet`): HoBo.CD can realize a Kubernetes Camp
  through a Karmada control plane, with a PropagationPolicy pinned to exactly one member cluster
  (`clusterAffinity.clusterNames`, `Duplicated`) and status read from the binding. HoBo never uses
  Karmada's scheduler, failover or overrides for its deliveries; that would be a second placement
  engine.
- **Borrow** (done): spread, taints, purge modes, state handover, retained fields, explicit
  rebalance ([ADR-0182](../design/adr/01-architecture-core.md#adr-0182)).
- **Benchmark** on fleet-scale failover behavior.

## Threats and lessons

1. **Automatic failover is where multi-cluster systems hurt people.** HoBo requires two signals,
   one Station-observed, and Rail permission.
2. **Overrides are popular because per-target variation is real.** HoBo's answer (typed Camp
   topology) must be as easy to use.
3. **Brownfield estates already run Karmada.** The transport adapter is how HoBo coexists.

## Sources

- [Failover analysis](https://karmada.website.cncfstack.com/docs/userguide/failover/failover-analysis)
- [Cluster taint management](https://karmada.website.cncfstack.com/docs/userguide/failover/cluster-taint-management)
- [Application failover](https://karmada.cncfstack.com/docs/v1.9/userguide/failover/application-failover)
- [ClusterOverridePolicy reference](https://karmada.website.cncfstack.com/docs/v1.14/reference/karmada-api/policy-resources/cluster-override-policy-v1alpha1)
- [Resource interpreter customization](https://karmada.website.cncfstack.com/docs/reference/karmada-api/config-resources/resource-interpreter-customization-v1alpha1)
- [FederatedResourceQuota](https://karmada.cncfstack.com/docs/reference/karmada-api/policy-resources/federated-resource-quota-v1alpha1)
- [WorkloadRebalancer](https://karmada.website.cncfstack.com/docs/userguide/scheduling/workload-rebalancer)
- [Cluster registration](https://karmada.website.cncfstack.com/docs/userguide/clustermanager/cluster-registration)
- [CNCF graduation coverage](https://infoq.com/news/2026/09/karmada-kubernetes-cncf)

Install base and the exact release in which each failover feature shipped were not verified in
this pass and are not asserted beyond the v1.14 `NoExecute` change the plan research recorded.
