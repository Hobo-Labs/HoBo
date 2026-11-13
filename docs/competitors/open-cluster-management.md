---
type: Competitive Reference
title: "Open Cluster Management — Competitor Reference"
description: "CNCF Sandbox hub-and-spoke Kubernetes fleet management: double opt-in registration, ClusterClaims, ManagedClusterSets, Placement with decision groups, ManifestWork and ManifestWorkReplicaSet rollouts, and inform-then-enforce governance. The source of HoBo.CD's enrollment, Camp sets, fan-out and posture models, and an optional transport for Kubernetes Camps."
tags: [hobo, competitors]
competitor:
  slug: open-cluster-management
  name: "Open Cluster Management"
  aliases: ["ocm", "red-hat-acm"]
  primary_category: hybrid-multicloud-enterprise
  categories: [hybrid-multicloud-enterprise, delivery-release-gitops, finops-governance-placement]
  directness: overlapping
  role: "the fleet inventory, rollout-group and governance reference HoBo.CD borrows double opt-in enrollment, Camp sets, decision groups and inform-then-enforce from, and an optional ManifestWork transport for Kubernetes Camps"
  posture: [borrow, integrate, benchmark]
  hobo_surface: [environments, delivery, governance, provider-matching]
  evidence: implemented
  status: active
  research_date: 2026-11-11
  sources:
    - https://main--open-cluster-management.netlify.app/docs/concepts/architecture
    - https://main--open-cluster-management.netlify.app/docs/concepts/work-distribution/manifestworkreplicaset
    - https://main--open-cluster-management.netlify.app/docs/getting-started/integration/policy-controllers/policy
    - https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/governance
---

# Open Cluster Management — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-11-11**, read for plan 0024
> (HoBo.CD). Read alongside [Karmada](karmada.md). Red Hat Advanced Cluster Management is the
> commercial distribution and is covered here as an alias.

## What it is

Open Cluster Management (OCM) is a **hub-and-spoke fleet manager for Kubernetes** in the CNCF
Sandbox. A hub cluster holds the inventory and the work; an agent on each managed cluster pulls
its work and reports status.

- **Product boundary.** Cluster registration and inventory, placement, work distribution with
  progressive rollout, add-ons, and governance (policy with inform/enforce and compliance status).
  It does not build or promote application versions.
- **Operating model.** Open source; Red Hat ACM is the supported distribution.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **ManagedCluster** | A registered cluster; registration needs acceptance on both sides (double opt-in) |
| **ClusterClaim** | Facts a managed cluster reports about itself |
| **ManagedClusterSet** + binding | Groups of clusters, bound into namespaces that may target them |
| **Placement** | Predicates, prioritizers and decision groups that select clusters |
| **AddOnPlacementScore** | Scores reported for use by prioritizers |
| **ManifestWork** | Resources to apply on one managed cluster, with feedback rules and delete options |
| **ManifestWorkReplicaSet** | ManifestWorks fanned out over a Placement with `All`, `Progressive` or `ProgressivePerGroup` rollout |
| **Policy** | Governance templates with `inform` or `enforce` remediation and compliance status |

## Feature surface

- Pull-based agents; the hub never needs inbound access to spokes.
- Double opt-in registration with separate permissions.
- Placement with label/claim predicates, prioritizers, decision groups.
- Progressive rollout of work with concurrency, minimum success time, progress deadline, maximum
  failures and mandatory decision groups.
- Feedback rules that read selected fields back from applied resources.
- Policy with inform/enforce, compliance history, and hub templates.

## Architecture

- Hub cluster: registration, placement, work and policy controllers.
- Klusterlet on each managed cluster: registration agent and work agent, pulling from the hub.
- Transports beyond the Kubernetes API (Maestro over MQTT/gRPC/Kafka) exist for scale.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `environments` | Managed clusters and cluster sets vs Camps and Camp sets |
| `delivery` | ManifestWorkReplicaSet rollouts vs HoBo.CD fan-out of verified per-Camp promotions |
| `governance` | OCM Policy inform/enforce vs Rails delivered INFORM → ENFORCE and posture |
| `provider-matching` | OCM Placement vs HoBo.CD Placement |

## Primitive mapping

| OCM | HoBo.CD | Honest correspondence |
| --- | ------- | --------------------- |
| Double opt-in registration | Enrollment: `reconciler.approve-key` + `reconciler.accept` | Close. |
| ClusterClaim | Observed claims | Close, but HoBo claims only narrow; they never satisfy residency or a binding. |
| ManagedClusterSet + binding | Camp set bound by a Rail | Close. |
| Placement, prioritizers, decision groups | Placement with score snapshots and groups | Close, and replayable: recorded inputs reproduce the decision. |
| AddOnPlacementScore | `ScoreSnapshotRecord` with `valid_until` | Close; expired scores are ignored. |
| ManifestWorkReplicaSet `All`/`Progressive`/`ProgressivePerGroup` | Fan-out strategies | Close, with deferral for unreachable Camps and quorum downstream. |
| `feedbackRules` | `observe_fields` | Close. |
| `SelectivelyOrphan` | `ORPHAN_DATA` departure | Close. |
| `ReadOnly` | `OBSERVE_ONLY` Camps | Close. |
| Policy inform → enforce | Rail `INFORM` → `ENFORCE` nodes, posture | Close, but enforcement acts only through repair Deltas. |
| Hub templates, CEL conditions | — | **Rejected:** no templating or expression language; hub templates can copy secrets to spokes. |
| Policy controllers mutating targets | — | **Rejected:** one mutator per Camp. |

## Where Open Cluster Management is stronger

- **Kubernetes fleet depth**: add-on framework, cluster lifecycle, and a broad policy library.
- **Enterprise distribution** through Red Hat ACM.
- **Scale transports** for very large fleets.

## Where HoBo is stronger or intentionally different

- **Not Kubernetes-only** (*implemented*). Camps are any platform.
- **One rollout model for work and policy, with verification** (*implemented*). Fan-out promotes
  verified Freight per Camp, and Rails ride the same pipelines.
- **One mutator** (*implemented*). Posture never mutates a target directly; a contradiction with a
  Set-owned value is `ownership-conflict`.
- **No broker transport** (*intentional*). The journal and cursor feed resume over intermittent
  links without an operated message broker.

## Adversarial critique

- **Policy controllers that enforce by mutating targets** create a second writer that can fight
  delivery.
- **Hub templates** can copy secrets to spokes.
- **CEL and templating** in placement and policy make decisions harder to replay.
- **ManifestWorkReplicaSet rollback** was still an enhancement proposal when researched.

## Better-together / integration posture

- **Integrate** (*implemented* in `@hobo/cd-kube-fleet`): ClusterProfiles import as `OBSERVE_ONLY`
  Camps, and promoted Camps realize through **one ManifestWork per Camp** in the hub's cluster
  namespace, with status from feedback rules. HoBo deliveries never use ManifestWorkReplicaSet or
  OCM Placement; HoBo's fan-out, verification and rollback govern.
- **Borrow** (done): double opt-in, claims, cluster sets, decision groups, rollout strategies,
  feedback rules, orphaning, read-only management, inform-then-enforce
  ([ADR-0181](../design/adr/01-architecture-core.md#adr-0181)).
- **Benchmark** on fleet governance reporting.

## Threats and lessons

1. **Brownfield OCM estates exist.** Observe-only import with immediate posture is the adoption
   path.
2. **Inform-then-enforce is how operators trust policy.** HoBo makes the shadow period a
   verified pipeline stage.
3. **Self-reported facts are an attack surface.** HoBo's claims narrow and never grant.

## Sources

- [Architecture](https://main--open-cluster-management.netlify.app/docs/concepts/architecture)
- [Placement](https://main--open-cluster-management.netlify.app/docs/concepts/content-placement/_print)
- [ManifestWorkReplicaSet](https://main--open-cluster-management.netlify.app/docs/concepts/work-distribution/manifestworkreplicaset)
- [ManifestWork](https://deploy-preview-531--open-cluster-management.netlify.app/docs/concepts/work-distribution/_print)
- [Policy API](https://main--open-cluster-management.netlify.app/docs/getting-started/integration/policy-controllers/policy)
- [Red Hat ACM governance](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/governance)
- [Decision groups (ACM-6806)](https://issues.redhat.com/browse/ACM-6806)
- [Maestro (ACM-22339)](https://issues.redhat.com/browse/ACM-22339)

Install base, Maestro's production status and the current state of the MWRS rollback proposal were
not verified beyond the plan research and are not asserted.
