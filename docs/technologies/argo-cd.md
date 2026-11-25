---
type: Reference
title: "Argo CD — Technology Reference"
description: "CNCF-graduated declarative GitOps CD for Kubernetes (Application CRD, sync waves, app-of-apps, ApplicationSets); reference target of HoBo's GitOps publisher mode."
tags: [hobo, technologies]
---

# Argo CD

> **Technology** · CNCF-graduated declarative GitOps continuous delivery for
> Kubernetes: desired state in Git, an `Application` CRD, automated or manual
> sync with health/status surfaced in a UI. Sources: argo-cd.readthedocs.io,
> github.com/argoproj. Factual surface quoted under fair use.

## What it is

Argo CD watches Git repositories holding Kubernetes manifests (plain, Helm,
Kustomize, plugins) and reconciles clusters to match. Its `Application` CRD
names source repo/path/revision and destination cluster/namespace; **sync
waves + hooks** order rollouts; **app-of-apps** and **ApplicationSets**
template fleets of applications across clusters; sync windows, drift
detection, and RBAC-scoped projects govern operations. Argo Rollouts (sibling
project) adds canary/blue-green strategies.

## Key features

- **Git as the source of truth** — desired state reviewed/merged like code;
  the cluster converges to it (pull-based).
- **Application CRD + projects** — typed unit of delivery with RBAC scoping.
- **Sync waves / hooks / windows** — ordered, gated, time-boxed rollouts.
- **ApplicationSets** — generator-driven fan-out (cluster/list/matrix/Git).
- **Drift detection + self-heal** — divergence is surfaced or auto-reverted.

## Relevance to HoBo

**Informs — the reference rendering target for GitOps publisher mode.** HoBo's
default deploy path is not GitOps (the event-sourced control plane is the
source of truth; ADR-0121), but **GitOps publisher mode**
([platform-engineering](../design/platform-engineering.md#plan-25) §GitOps,
[patterns/gitops-runbook-promotion](../patterns/gitops-runbook-promotion.md),
[standards/opengitops](../standards/opengitops.md)) renders Deployment Sets
into a Git repo an Argo CD instance can own, and the HoBo Broker's
`broker_delivery_argocd` flag ([hobo-broker](../design/hobo-broker.md))
renders `Application` documents directly. What HoBo borrows: **immutable
desired-state artifacts under review** (mirrored as immutable Deployment Sets
+ Deltas), **ordered gated sync** (mirrored by stage-gate + Gatekeeper rather
than sync waves), and **drift surfacing** (`hobo drift`). Divergence kept
honest: in HoBo the journal, not Git, is authoritative — publisher mode is a
one-way projection for orgs whose operational trust anchors on Git; Argo CD
then owns only the Kubernetes substrate leg.

## Sources

- https://argo-cd.readthedocs.io — Application spec, sync, ApplicationSets
- https://github.com/argoproj/argo-cd
- https://opengitops.dev — the principles both sides speak
