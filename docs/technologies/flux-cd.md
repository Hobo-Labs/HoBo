---
type: Reference
title: "Flux CD — Technology Reference"
description: "CNCF-graduated GitOps toolkit for Kubernetes (source-controller, Kustomization/HelmRelease reconcilers, OCI artifacts, image automation); informs HoBo's pull-based publisher + bundle distribution."
tags: [hobo, technologies]
---

# Flux CD

> **Technology** · CNCF-graduated "GitOps toolkit": a set of composable
> Kubernetes controllers (source, kustomize, helm, notification, image
> automation) reconciling clusters from Git/OCI/Helm sources. Sources:
> fluxcd.io/docs, github.com/fluxcd. Factual surface quoted under fair use.

## What it is

Flux decomposes GitOps into controllers: **source-controller** fetches and
verifies artifacts (Git repos, Helm repos, S3 buckets, **OCI artifacts** —
signed with cosign), **kustomize-controller** and **helm-controller** apply
them (`Kustomization`, `HelmRelease` CRDs with `dependsOn` ordering),
**image-automation** writes new image tags back to Git, and
**notification-controller** fans events out. Multi-tenancy is first-class
(per-namespace reconcilers, impersonation), and everything is
building-block-shaped rather than one monolithic app server.

## Key features

- **Toolkit decomposition** — small controllers with single responsibilities,
  composable per team/tenant.
- **OCI artifacts as a delivery source** — desired state distributed through
  container registries with signature verification, not only Git.
- **`dependsOn` ordering + health checks** across Kustomizations/HelmReleases.
- **Image update automation** — closes the loop from registry to Git commit.

## Relevance to HoBo

**Informs — pull-based delivery + signed-artifact distribution.** Alongside
[Argo CD](./argo-cd.md) as a rendering target for GitOps publisher mode
([patterns/gitops-runbook-promotion](../patterns/gitops-runbook-promotion.md),
[standards/opengitops](../standards/opengitops.md)). Flux's distinctive
lessons for HoBo: **OCI artifacts as the delivery channel with signature
verification** — congruent with HoBo's Registry listings, signed offline
bundles (`hobo registry import`, ADR-0036) and OCI-digest addressing — and the
**controller-toolkit decomposition**, congruent with HoBo's grain-based
control-plane services ([control-plane](../design/control-plane.md#plan-04))
where reconciliation is choreographed by events rather than one orchestrator.
Divergence kept honest: HoBo reconciles from its event journal, not from Git;
Flux's write-back image automation has no HoBo analog (promotion is a
Gatekeeper-gated event, not a Git commit).

## Sources

- https://fluxcd.io/flux — toolkit docs (sources, Kustomizations, OCI)
- https://github.com/fluxcd/flux2
- https://opengitops.dev
