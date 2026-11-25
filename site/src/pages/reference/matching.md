---
layout: ../../layouts/Docs.astro
title: Matching & ResourceActors
description: "Resource Definitions, Matching placement, ResourceIntent lowering, ResourceActor reconciliation FSM, and choreography over central orchestrators."
---

# Matching & ResourceActors

## Matching

**Matching** resolves each Bindle resource against **Resource Definitions** and provider capability to choose *where* and *how* a resource is realized. It is the placement brain inside plan/up — not a separate product noun beside Gatekeeper.

Flow (conceptual):

1. Resource collection produces provider-agnostic **manifest IR**.
2. Each node lowers to **ResourceIntent** (FinOps/routing-friendly, provider-neutral).
3. Matching + policy + cost solve a **DeploymentPlan** DAG.
4. Gatekeeper admits or denies the plan.
5. ResourceActors converge desired → actual.

## ResourceActor

One **ResourceActor** (controller-style grain) per resource owns reconciliation:

| State (conceptual) | Meaning |
|---|---|
| Desired | From DeploymentPlan |
| Progressing | Executor in flight |
| Ready | Provider reports healthy |
| Failed | Past no-go threshold → compensation choreography |
| Drifted | Actual ≠ desired → governed remediation |

## Choreography over orchestration

- Independent subtrees provision **concurrently**.
- No single coordinator SPOF for every resource.
- Compensation is also choreographed: `resource.Failed` past threshold → `deployment.RolledBack` fans out.
- **DeploymentView** projection reconstructs the saga graph for humans/agents.

## Executors

Sandboxed runners (Firecracker-class) apply IaC/builds with **short-lived scoped tokens** — no ambient cloud creds. Stdout streams via Streamer; state events hit the control log.

## Continuous re-placement

Dispatcher re-enters Matching when price/policy/reliability signals change. Same plan → gate → converge path as human `hobo up` — migration is not a special engine.

## Related

[Control plane](/HoBo/architecture/control-plane/) · [Conductor](/HoBo/primitives/stations/#the-conductor) · [Continuous migration](/HoBo/cicd/migration/) · [Event families](/HoBo/reference/events/)
