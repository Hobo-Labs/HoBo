---
type: CI Performance Finding
title: "Finding 170: CD Git publisher → Argo CD CONVERGED channel"
description: "Tracks the production observation required before HoBo CD GitOps publisher → Argo CD convergence rows leave built-not-proven on the Kargo/Argo parity scorecard (P9)."
tags: [hobo, cd, gitops, argocd, channel, observation, delivery]
---

# Finding 170: CD Git publisher → Argo CD CONVERGED channel

**Status:** open — built, not proven. P6–P7 stack renders Applications and observes sync
in tests; no linked production run shows `observe()` returning CONVERGED with the Git
revision the publisher committed.

**Channel:** `packages/cd-gitops` `PublisherPort.publish` → remote Git → Argo CD pull →
`PublisherPort.observe` reading Application sync/health with `status.sync.revision`
matching the published commit. The Application's `spec.source.targetRevision` names
the configured branch.

**Scorecard:** `docs/cd/parity-gap-kargo-argocd.md` Argo rows (Application, sync/health,
pull GitOps) stay **built-not-proven** until this finding records one production
observation (run URL or status read) per AGENTS.md.

## Evidence gate

| Gate | Requirement | Linked observation |
| --- | --- | --- |
| G1 | Publisher commit lands on the configured branch with Camp manifest paths | _pending_ |
| G2 | Argo CD Application reports Synced + Healthy for that revision | _pending_ |
| G3 | HoBo `observe()` returns CONVERGED referencing the same Git SHA | _pending_ |

## How to close

1. Deploy a MANAGED Camp with `publisher` reconciler mode and Argo CD engine via Git.
2. Promote Freight through the stack so `publish` runs once in production.
3. Capture Argo UI or API read showing revision + health, and HoBo observation log/event.
4. Paste links in the table above and update the parity scorecard to **pass** or
   **built-not-proven** with the observation URL in the same commit.
