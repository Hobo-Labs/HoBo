---
layout: ../../layouts/Docs.astro
title: Control plane
description: "The Yard: Gateway, Planner, Orchestrator, Dispatcher, Identity, Registry, Executors — event-sourced infrastructure convergence."
---

# Control plane

The **Yard** is HoBo’s provider-specific control plane: it decides *what infrastructure should exist* and drives it to reality. It is **never** on the critical path of a live user request to your app.

## Components

| Component | Job |
|---|---|
| **Gateway** | Authn/z; SDK / REST / MCP ingress |
| **Identity** | Workload SVIDs, OIDC, brokered short-lived provider tokens |
| **Registry** | Provider + capability catalog; certification records |
| **Planner** | Bindle + mapping → DeploymentPlan DAG; Matching |
| **Conductor (Broker)** | Policy-governed multi-provider placement |
| **Dispatcher** | Continuous re-placement (cost/policy/reliability) |
| **Orchestrator** | ResourceActors reconcile desired ↔ actual; sagas compensate |
| **Executors** | Sandboxed IaC/build with scoped credentials |
| **Event Store** | Append-only control-plane truth |
| **Read models** | Dashboards, inspect, status |

## Same path for deploy and migrate

`hobo up` and continuous migration share **plan → gate → converge**. There is no separate “migration engine” to trust. Dispatcher re-enters the same loop when a better home opens.

## Gates before reality

Nothing mutates cloud state until Gatekeeper (and friends) allow:

1. Contract compatibility (can-deploy)
2. Policy packs + obligations
3. Cost / quota
4. Golden suite (when enabled)
5. Optional secretless-config / can-migrate / can-trail / effects visibility

Machine-readable reasons ship on `gatekeeper.Decided` for agents and humans.

## ResourceActors & choreography

One ResourceActor per resource owns reconciliation. Independent subtrees provision concurrently. Failure past threshold choreographs rollback via events — not a single brittle coordinator thread. See [Matching & ResourceActors](/HoBo/reference/matching/).

## Executor sandbox

- Firecracker-class isolation; **no ambient cloud creds**
- Short-lived capability-scoped tokens per resource + action
- Stdout via Streamer; IaC state per resource backend
- Concurrency bounded per tenant and provider

## Self-host = hosted

The Yard is itself a Bindle. Bootstrapping a self-host Yard is the same lifecycle as any other app. Air-gapped profiles use signed offline bundles and in-boundary substitutes — see [Air-gapped](/HoBo/architecture/air-gapped/).

## Stations

A Conductor occupies a **Station** (hard isolation boundary). App topology (Bindle ⊂ Camp ⊂ Yard ⊂ Junction) is separate. Missing Station fails closed for control-plane work.

## Related

[Conductor](/HoBo/primitives/stations/#the-conductor) · [Identity](/HoBo/security/identity/) · [Stations](/HoBo/primitives/stations/) · [Matching](/HoBo/reference/matching/)
