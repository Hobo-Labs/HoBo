---
type: Runbook
title: "HoBo.CD runbook: GitOps publisher"
description: "Argo CD and Flux publishing through a Git host. Assembled from the Runbook section of packages/cd-gitops/README.md."
tags: [hobo, cd, runbook, cd-gitops]
---

# HoBo.CD runbook: GitOps publisher

Argo CD and Flux publishing through a Git host. This page is assembled from the **Runbook** section of `packages/cd-gitops/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Code | Action |
|---|---|---|
| Publisher refuses to load | `gitops-config-invalid` | Fix the named field (https URLs, `owner/name`, branch, relative prefix, DNS-1123 namespaces). |
| Every publish refused before any call | `gitops-credential-missing` | Store `{ token }` under `repository.credential_ref` (and `endpoint.credential_ref` for observation). |
| `outcome=gitops-host-auth-failed` | `gitops-host-auth-failed` | Token lacks contents write, or branch protection blocks the publisher. Grant it or use a dedicated branch. |
| `outcome=gitops-host-not-found` | `gitops-host-not-found` | Create the branch or fix `repository`/`branch`/`api_base_url`. |
| `outcome=gitops-host-conflict` repeatedly | `gitops-host-conflict` | Another writer shares the branch/prefix. Give HoBo its own branch or `path_prefix`. |
| `outcome=gitops-host-unavailable` | `gitops-host-unavailable` | Host outage or rate limit; nothing was committed. The reconciler retries next pass. |
| Camp stuck CONVERGING with `gitops-engine-not-found` | — | Bootstrap the root app / root Kustomization over `path_prefix`. |
| Camp stuck CONVERGING with `gitops-engine-unobservable` | — | Check `endpoint.api_base_url`, the engine token (`get` on applications or kustomizations) and network reach. |
| Camp BLOCKED with `gitops-engine-degraded` | — | Read the engine's conditions; roll back through HoBo (`hobo deploy rollback`), never by editing Git by hand. |
| `gitops-set-too-large` | — | Resolved set > 900 KiB: split the Bindle or use an agent reconciler for that Camp. |
| Broker policy still says `engine: argo` | — | Works through the `argo-cd` publisher; configure a publisher named `argo-cd`. |
