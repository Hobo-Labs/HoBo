---
layout: ../../layouts/Docs.astro
title: GitOps operator
description: "Crew GitOps: drive when/what deploys, promote across env-groups only when can-deploy is green."
---

# GitOps operator

**Mission:** drive *when* and *what* deploys; promote across environment groups under contract and policy gates.

## What it does

- Coordinates delivery pipelines and publishers (Argo/Flux-class engines optional behind a port).
- Promotes staging → prod **only** when `can-deploy` / Gatekeeper is green.
- On skew: blocks with a **precise, machine-readable reason** an agent can fix.
- Opens/rollback paths via MCP (`promote`, `rollback`) with policy checks.

## Gates it respects

| Gate | Why |
|---|---|
| can-deploy | Producer/consumer version skew |
| policy packs | Org deny ceilings, approvals |
| golden suite | Reproducible multi-check bundle |
| cost/quota | Budget breakers |

## Events

Rides `pipeline.*` / `deployment.*` plus `crew.ActionProposed` / `ActionApplied`. No separate GitOps-only log.

## RBAC example

Without Deployer role, GitOps may **propose** but not **promote**. Role bindings are mandatory-policy aware.

## Related

[Contracts & Gatekeeper](/HoBo/reference/contracts/) · [Deployment testing](/HoBo/testing/deployment/) · [Shared model](/HoBo/operations/shared-model/)
