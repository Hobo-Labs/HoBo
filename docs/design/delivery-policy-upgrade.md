---
type: Upgrade Notes
title: "Upgrading broker DeliveryPolicy to neutral reconciler modes"
description: "The broker's DeliveryPolicy no longer names a GitOps engine, cluster or namespace. Every receipt is delivered through @hobo/cd by a reconciler mode (conductor, agent or publisher). How old policies are read, what to change, and what is never read again."
tags: [hobo, design, cd, broker, delivery, upgrade]
---

# Upgrading `DeliveryPolicy`

**What changed.** The broker delivers through HoBo.CD
([ADR-0181](./adr/01-architecture-core.md#adr-0181) D14). `DeliveryPolicy` in
`packages/broker/data-models/broker.proto` is neutral: it says which
**reconciler mode** converges the delivery, and, for GitOps, which
`@hobo/cd-gitops` publisher target to use. It no longer names an engine, a
cluster or a namespace ([hobo-broker.md](./hobo-broker.md)).

| Field | Before | Now |
|---|---|---|
| `reconciler_mode` | — | `conductor`, `agent` or `publisher`. The field to set. |
| `publisher` | — | `{ target: argo-cd \| flux, repository }`. Required exactly when `reconciler_mode` is `publisher`. |
| `sync_mode`, `prune` | Read | Unchanged. |
| `engine` (`argo`, `in-proc`) | Selected the delivery engine | **Deprecated.** Read only when `reconciler_mode` is empty, and only to map it (below). |
| `gitops_repo` | Argo CD repository | **Deprecated.** Becomes `publisher.repository` for a legacy `argo` engine. |
| `destination_namespace` | Kubernetes namespace | **Deprecated and never read.** Namespaces belong to the target's Camp topology, not to a neutral broker type. |

## How an old policy is read

Old policies keep working; nothing needs to change on the day you upgrade.
When `reconciler_mode` is empty, the parser maps the deprecated fields once:

- `engine: argo` → `reconciler_mode: publisher` with `publisher.target:
  argo-cd`, and `gitops_repo` as `publisher.repository`.
- `engine: in-proc` (or no engine) → `reconciler_mode: conductor`.
- Any other `engine` value is refused with `invalid-delivery-engine`.

Stored `broker.DeliverySubmitted` events written before the change are
upcast the same way, so a replay reproduces the old deliveries through the new
path.

## What to change

1. Set `reconciler_mode` explicitly on every policy you own:
   - `conductor` for SaaS targets the Station or Yard service reaches;
   - `agent` for targets behind a private network, where an enrolled agent
     reads the delivery feed outbound (see the
     [agents runbook](../runbooks/cd/agent.md));
   - `publisher` for Argo CD or Flux estates, with `publisher.target` and
     `publisher.repository`.
2. Remove `engine`, `gitops_repo` and `destination_namespace`. A `publisher`
   mode without `publisher.target` is refused with `publisher-required`.
3. If you relied on `destination_namespace`, move the value into the target
   Camp's topology (a Camp property or `ResourceMappingRule`), which Matching
   already reads and the Deployment Set digest captures.

## Behavior differences

- Every broker delivery is now a promotion of Freight into a Camp, with the
  gate, change windows, verification and rollback of any other promotion.
- A `publisher` delivery is converged only when the GitOps engine reports it
  so; the commit alone is not success.
- Rollback re-applies the predecessor Set as a Delta. The old CD plane's
  rollback did not.
