---
type: Competitive Reference
title: "Rancher Fleet — Competitor Reference"
description: "GitOps at fleet scale: a GitRepo produces Bundles, Bundles become BundleDeployments per cluster, targeted by cluster selectors and cluster groups."
tags: [hobo, competitors]
competitor:
  slug: rancher-fleet
  name: "Rancher Fleet"
  aliases: ["fleet", "suse fleet"]
  primary_category: hybrid-multicloud-enterprise
  categories: [hybrid-multicloud-enterprise, delivery-release-gitops, runtime-substrates]
  directness: adjacent
  role: "fleet-scale GitOps whose Bundle-to-BundleDeployment split is the clearest separation of definition from per-target realization in the corpus"
  posture: [borrow, benchmark, integrate]
  hobo_surface: [delivery, provider-matching, reconciliation, environments]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://fleet.rancher.io/explanations/concepts
    - https://fleet.rancher.io/reference/ref-gitrepo
    - https://fleet.rancher.io/how-tos-for-users/gitrepo-targets
    - https://github.com/rancher/fleet
---

# Rancher Fleet — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.

## What it is

Fleet is **GitOps and HelmOps at scale**, from Rancher/SUSE: "a set of Kubernetes custom resource
definitions (CRDs) and controllers to manage GitOps for a single Kubernetes cluster or a large-scale
deployment of Kubernetes clusters" ([concepts](https://fleet.rancher.io/explanations/concepts)).

Its distinguishing concern is **scale of targets** rather than sophistication of delivery: the design
question is what happens when the same definition must land on hundreds or thousands of clusters
that differ from each other.

- **Product boundary.** Deploy from Git to many clusters, with per-cluster customization. Not a
  platform, not a portal.
- **Operating model.** Open source, Kubernetes-native, usable standalone or inside Rancher.
- **Commercial status.** Apache-2.0 ([rancher/fleet](https://github.com/rancher/fleet)), with SUSE
  commercial support around Rancher.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **GitRepo** | "A custom resource where you specify a git repository URL to be monitored, with configuration for deployment targets" |
| **Bundle** | "The fundamental deployment unit used in Fleet" — a collection of resources produced by scanning a GitRepo, whose contents "may be Kubernetes manifests, Kustomize configuration, or Helm charts, which are dynamically rendered into a Helm chart and installed as a Helm release" |
| **BundleDeployment** | "When a Bundle is deployed to a cluster an instance of a Bundle is called a BundleDeployment, representing the state of that Bundle on a specific cluster **with its cluster-specific customizations**" |
| **Target / cluster group** | The selector mechanism: clusters "must be mapped to a target using the `spec.targets` field to match clusters or cluster groups" |

The mental model is **one definition, many realizations, each with its own state**. That
Bundle/BundleDeployment split is the interesting design: the definition is shared, the deployment is
per-target, per-target customization is a first-class field, and each target's status is tracked
separately rather than aggregated into one green tick.

## Feature surface

- Git scanning producing bundles, with paths and multiple bundles per repository.
- Contents as raw manifests, Kustomize overlays, or Helm charts — all normalized to a Helm release.
- Cluster selection by label, by explicit list, or by cluster group.
- Per-target customization overlaid on the shared bundle.
- Per-BundleDeployment status, so partial rollouts across a fleet are visible.
- Rollout control across targets, and drift correction on each.
- Kubernetes-native throughout: everything is a CRD, so RBAC, watch and tooling come free.

## Architecture

- **Control plane** — Fleet controllers in a management cluster, watching GitRepos and producing
  Bundles.
- **Agents** — a Fleet agent per downstream cluster reconciling its BundleDeployments.
- **Execution** — bundle contents are rendered to a Helm chart and installed as a release, which
  gives lifecycle and rollback semantics for free regardless of the input format.
- **State authority** — Git for definitions; BundleDeployment status per cluster for realization.
- **Scale posture** — the design's whole point: agent-per-cluster with per-target status is what
  makes thousands of clusters tractable, rather than one controller reconciling everything.
- **Portability boundary** — Kubernetes clusters, and only Kubernetes clusters.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | GitOps delivery with per-target rollout status |
| `provider-matching` | **Target selection by labels and cluster groups** — a declarative way to say which realizations a definition should have |
| `reconciliation` | Per-cluster agents converging their own state |
| `environments` | Cluster groups as environment-shaped scopes |

Fleet does not model applications, choose between heterogeneous providers, or record decisions. The
overlap is *one definition to many targets*, which is structurally the same problem HoBo's matching
solves at a different altitude.

## Primitive mapping

| Fleet | Nearest HoBo concept | Honest correspondence |
| ----- | -------------------- | --------------------- |
| GitRepo | Source of manifests | Partial. |
| **Bundle** | Bindle (the shared definition) | **Close in role.** Both are the definition that will be realized more than once. |
| **BundleDeployment** | Deployment into a Camp | **The most useful mapping in this capture.** Fleet makes "this definition, on that target, with these customizations, in this state" a first-class object. HoBo has the concept; Fleet's explicitness about per-target *state* is worth studying. |
| Target selector / cluster group | Camp/Yard selection | **Partial, and instructive.** Label selection is declarative and static; HoBo's matching is scored and recorded. Fleet's is more legible; HoBo's can express cost and residency. |
| Helm release rendering | Provider realization | Partial. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** Targets are selected by label, and nothing is scored. |

## Where Rancher Fleet is stronger

- **It is built for the number of targets HoBo talks about but has not faced.** Thousands of clusters
  is a stated design point, not an aspiration.
- **Per-target state as a first-class object.** BundleDeployment means a partially-failed fleet
  rollout is legible rather than a single aggregate status.
- **Format-agnostic input.** Manifests, Kustomize and Helm all normalize to a Helm release, so
  adoption does not require rewriting what teams already have.
- **Kubernetes-native and Apache-2.0**, so it inherits RBAC, audit and tooling with no plugin API.
- **Simple mental model.** Four concepts total, which is rare in this corpus.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Targets are heterogeneous providers, not clusters** (*implemented*). Fleet's fleet is Kubernetes
  all the way down.
- **Target selection is scored and recorded** (*implemented*, `match.Decided`) rather than matched by
  label.
- **The definition is provider-abstract** (*implemented*). A Bundle contains Kubernetes resources; a
  Bindle contains capability requirements.
- **Event-sourced authority with replay** (*implemented*, ADR-0135).
- **Fail-closed residency** (*implemented*, ADR-0146) — cluster labels are not a jurisdiction model,
  and fleet-scale deployment across regions is exactly where that bites.
- **Honest caveat.** On operating delivery across very large numbers of targets, Fleet is proven and
  HoBo is not.

## Adversarial critique

- **Kubernetes-only, by construction.** Everything is a CRD and every target is a cluster.
- **Label-based targeting is coarse and drifts.** Cluster labels are metadata someone maintains;
  as the fleet grows, the taxonomy becomes the real system and nothing validates it.
- **Everything becomes a Helm release**, which is convenient and imposes Helm's semantics — including
  its templating and upgrade behaviour — on inputs that were not Helm.
- **Fleet-scale failure modes are subtle.** Partial rollouts, per-cluster drift and agent version skew
  across thousands of clusters are operationally demanding regardless of the model's elegance.
- **Git is the only source.** Anything not expressible as repository contents is out of scope.
- **No decision record.** Which clusters got a bundle is derivable from labels; *why those clusters*
  is not recorded anywhere.
- **Rancher gravity.** Usable standalone and clearly best-supported inside the Rancher ecosystem.

## Better-together / integration posture

- **Borrow** — **the Bundle/BundleDeployment split**: separating the shared definition from a
  first-class per-target deployment object with its own customizations and its own status. HoBo has
  the concept implicitly; making per-Camp realization an addressable object with independent status
  would make fleet-scale rollouts legible.
- **Integrate** — HoBo could emit into Git for Fleet to distribute, which composes cleanly: HoBo
  decides and renders, Fleet distributes at scale.
- **Benchmark** on partial-rollout visibility across many targets.
- Not a displace or adopt target.

## Threats and lessons

1. **Scale changes the design, not just the numbers.** Fleet's per-target object exists because
   aggregate status is useless at a thousand clusters. HoBo's multi-Camp story needs the same
   property before it meets a large estate.
2. **Label selection is legible; scoring is powerful.** Fleet users can read a selector and know what
   will happen. HoBo's matching should be equally explainable, which is an argument for surfacing
   the decision rather than only recording it.
3. **Meeting teams at their existing format matters** — manifests, Kustomize and Helm all work
   unchanged. Fourth corpus occurrence of the import-what-exists finding.
4. **Normalizing to one internal representation** (a Helm release) is a clean way to accept many
   input formats, and worth considering for HoBo's own ingestion paths.

## Sources

- [Fleet core concepts](https://fleet.rancher.io/explanations/concepts) — GitRepo, Bundle, BundleDeployment definitions
- [GitRepo resource](https://fleet.rancher.io/reference/ref-gitrepo) and [mapping to downstream clusters](https://fleet.rancher.io/how-tos-for-users/gitrepo-targets) — targets, cluster groups, selectors
- [Bundle resource](https://fleet.rancher.io/ref-bundle) and [bundle lifecycle](https://fleet.rancher.io/0.7/ref-bundle-stages) — bundle contents and stages
- [rancher/fleet](https://github.com/rancher/fleet) — source and licence
- [Fleet in Rancher Manager](https://ranchermanager.docs.rancher.com/integrations-in-rancher/fleet/) — integrated usage

Tested cluster-count limits and agent version-skew tolerance were not verified in this pass and are
not asserted.
